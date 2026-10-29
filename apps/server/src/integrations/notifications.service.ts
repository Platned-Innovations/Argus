import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { type DataStore, type Job, type NotificationRule, type Repository, type Ticket, type User } from '@argus/data';
import {
  isEmailChannel,
  type NotificationEvent,
  type NotificationRuleDto,
  type NotificationRuleInput,
  type Severity,
  SEVERITIES,
  TICKET_STATUS_LABELS,
  type TicketEmailInput,
} from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { DomainEvents, type EmergingThreat } from '../core/domain-events';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { JobRunner, PermanentJobError } from '../jobs/job-runner.service';
import { TicketsService } from '../tickets/tickets.service';
import { severityRank } from '../tickets/ticket-rules';
import { ChannelsService } from './channels.service';
import { type Message } from './messages';
import { IntegrationError } from './outbound';

export const NOTIFY_JOB = 'notification.deliver';
const DIGEST_KEY = 'notifications.lastDigestWeek';

interface NotifyPayload {
  ruleId: string;
  event: NotificationEvent;
  ticketId?: string;
  repoId?: string;
  runId?: string;
  error?: string;
  threat?: EmergingThreat;
}

/** ISO week id such as "2026-W44", used so each weekly digest is sent once. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function toRuleDto(r: NotificationRule): NotificationRuleDto {
  return { ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

/**
 * Turns domain events into notifications according to the rules, and delivers them through the job queue
 * (so slow or failing channels are retried and never block scans).
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly channels: ChannelsService,
    private readonly tickets: TicketsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly runner: JobRunner,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.runner.register(NOTIFY_JOB, (job) => this.deliver(job));
    this.events.on('ticket.created', ({ ticket }) => this.fanOut('ticket_created', ticket));
    this.events.on('ticket.reopened', ({ ticket }) => this.fanOut('ticket_reopened', ticket));
    this.events.on('ticket.sla_breached', ({ ticket }) => this.fanOut('sla_breached', ticket));
    this.events.on('scan.failed', async ({ repo, run, error }) => {
      for (const rule of await this.matchingRules('scan_failed', repo.teamId, null)) {
        await this.enqueue({ ruleId: rule.id, event: 'scan_failed', repoId: repo.id, runId: run.id, error });
      }
    });
    this.events.on('scheduler.tick', ({ now }) => this.maybeSendDigests(now));
    this.events.on('intel.emerging_threats', async ({ threats }) => {
      for (const threat of threats) {
        const rules = (await this.matchingRules('emerging_threat', null, threat.severity)).filter((r) => !r.teamIds.length || threat.teamIds.some((t) => t !== null && r.teamIds.includes(t)));
        for (const rule of rules) await this.enqueue({ ruleId: rule.id, event: 'emerging_threat', threat });
      }
    });
  }

  // ------------------------------------------------------------------ rules

  async listRules(): Promise<NotificationRuleDto[]> {
    return (await this.store.notificationRules.list()).map(toRuleDto);
  }

  async createRule(input: NotificationRuleInput, actor: User, ctx: RequestContext): Promise<NotificationRuleDto> {
    await this.assertChannels(input.channelIds);
    const r = await this.store.notificationRules.create(input);
    await this.audit.record({ action: 'notification_rule.created', actor, target: { type: 'notification_rule', id: r.id }, details: { name: r.name, events: r.events }, ip: ctx.ip });
    return toRuleDto(r);
  }

  async updateRule(id: string, input: NotificationRuleInput, actor: User, ctx: RequestContext): Promise<NotificationRuleDto> {
    if (!(await this.store.notificationRules.findById(id))) throw new NotFoundException('Rule not found.');
    await this.assertChannels(input.channelIds);
    const r = (await this.store.notificationRules.update(id, input))!;
    await this.audit.record({ action: 'notification_rule.updated', actor, target: { type: 'notification_rule', id }, details: { name: r.name, enabled: r.enabled }, ip: ctx.ip });
    return toRuleDto(r);
  }

  async deleteRule(id: string, actor: User, ctx: RequestContext): Promise<void> {
    const r = await this.store.notificationRules.findById(id);
    if (!r || !(await this.store.notificationRules.delete(id))) throw new NotFoundException('Rule not found.');
    await this.audit.record({ action: 'notification_rule.deleted', actor, target: { type: 'notification_rule', id }, details: { name: r.name }, ip: ctx.ip });
  }

  private async assertChannels(ids: string[]): Promise<void> {
    for (const id of ids) await this.channels.require(id);
  }

  // ------------------------------------------------------------------ dispatch

  private async matchingRules(event: NotificationEvent, teamId: string | null, severity: Severity | null): Promise<NotificationRule[]> {
    return (await this.store.notificationRules.list()).filter(
      (r) =>
        r.enabled &&
        r.events.includes(event) &&
        (!r.teamIds.length || (teamId !== null && r.teamIds.includes(teamId))) &&
        (severity === null || severityRank(severity) >= severityRank(r.minSeverity)),
    );
  }

  private async fanOut(event: NotificationEvent, ticket: Ticket): Promise<void> {
    for (const rule of await this.matchingRules(event, ticket.teamId, ticket.severity)) {
      await this.enqueue({ ruleId: rule.id, event, ticketId: ticket.id, repoId: ticket.repoId });
    }
  }

  private async enqueue(p: NotifyPayload): Promise<void> {
    await this.store.jobs.enqueue({ type: NOTIFY_JOB, payload: p as unknown as Record<string, unknown>, maxAttempts: 3, priority: 1 });
    this.runner.poke();
  }

  private link(path: string): string | null {
    return this.config.publicUrl ? `${this.config.publicUrl}${path}` : null;
  }

  ticketMessage(event: NotificationEvent | 'ticket_email', t: Ticket, repo: Repository | null, note?: string | null): Message {
    const prefix = { ticket_created: 'New', ticket_reopened: 'Reopened', sla_breached: 'SLA breached', ticket_email: '' } as Record<string, string>;
    return {
      event,
      title: `${prefix[event] ? `${prefix[event]}: ` : ''}${t.key} ${t.title}`,
      summary: t.description?.slice(0, 1500) ?? t.title,
      severity: t.severity,
      url: this.link(`/tickets/${t.id}`),
      note,
      facts: [
        { name: 'Repository', value: repo?.fullName ?? t.repoId },
        { name: 'Severity', value: `${t.severity} (risk ${t.riskScore})` },
        { name: 'Status', value: TICKET_STATUS_LABELS[t.status] },
        ...(t.dueAt ? [{ name: 'Due', value: t.dueAt.toISOString().slice(0, 10) }] : []),
        ...(t.remediation ? [{ name: 'How to fix', value: t.remediation.slice(0, 500) }] : []),
      ],
    };
  }

  private async deliver(job: Job): Promise<void> {
    const p = job.payload as unknown as NotifyPayload;
    const rule = await this.store.notificationRules.findById(p.ruleId);
    if (!rule || !rule.enabled) return;
    const repo = p.repoId ? await this.store.repositories.findById(p.repoId) : null;

    let message: Message;
    let extraRecipients: string[] = [];
    if (p.event === 'weekly_digest') message = await this.digestMessage(rule);
    else if (p.event === 'emerging_threat' && p.threat) {
      const t = p.threat;
      // A team-scoped rule only names that team's repositories.
      const repos = (await this.store.repositories.findByIds(t.repoIds)).filter((r) => !rule.teamIds.length || (r.teamId !== null && rule.teamIds.includes(r.teamId)));
      if (!repos.length) return;
      if (rule.includeRepoRecipients) extraRecipients = repos.flatMap((r) => r.notifyEmails);
      message = {
        event: p.event,
        title: `Emerging threat: ${t.packageName} — ${t.title}`.slice(0, 250),
        summary: `A newly published advisory (${t.advisoryId}) affects ${repos.length} repository(ies) in their current dependencies. Argus opened ${t.findings} finding(s) without waiting for the next scan.`,
        severity: t.severity,
        url: this.link('/intel'),
        facts: [
          { name: 'Advisory', value: t.advisoryId },
          { name: 'Package', value: `${t.packageName} (${t.ecosystem})` },
          { name: 'Severity', value: t.severity },
          { name: 'Repositories', value: repos.slice(0, 10).map((r) => r.fullName).join(', ') + (repos.length > 10 ? ` and ${repos.length - 10} more` : '') },
        ],
      };
    }
    else if (p.event === 'scan_failed') {
      message = {
        event: p.event,
        title: `Scan failed: ${repo?.fullName ?? p.repoId}`,
        summary: p.error ?? 'The scan failed.',
        severity: null,
        url: repo ? this.link(`/repositories/${repo.id}`) : null,
        facts: [{ name: 'Repository', value: repo?.fullName ?? String(p.repoId) }],
      };
    } else {
      const ticket = p.ticketId ? await this.store.tickets.findById(p.ticketId) : null;
      if (!ticket) return;
      message = this.ticketMessage(p.event, ticket, repo);
    }

    const recipients = [...new Set([...rule.recipients, ...(rule.includeRepoRecipients && repo ? repo.notifyEmails : []), ...extraRecipients])];
    const failures: string[] = [];
    let delivered = 0;
    for (const id of rule.channelIds) {
      const channel = await this.store.channels.findById(id);
      if (!channel || !channel.enabled) continue;
      if (isEmailChannel(channel.type) && !recipients.length) continue;
      try {
        await this.channels.send(channel, message, { to: recipients });
        delivered++;
      } catch (err) {
        failures.push(`${channel.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length && !delivered) {
      // Nothing got through: let the job runner retry later.
      throw new (failures.every((f) => /disabled|No recipients/.test(f)) ? PermanentJobError : IntegrationError)(failures.join('; '));
    }
    if (failures.length) this.logger.warn(`Rule "${rule.name}" partly failed: ${failures.join('; ')}`);
  }

  // ------------------------------------------------------------------ weekly digest

  private async maybeSendDigests(now: Date): Promise<void> {
    if (now.getUTCDay() !== 1 || now.getUTCHours() < 7) return;
    const week = isoWeek(now);
    if ((await this.settings.getSystemValue<string>(DIGEST_KEY)) === week) return;
    await this.settings.setSystemValue(DIGEST_KEY, week);
    // Each rule's digest covers its own team scope (see digestMessage).
    for (const rule of await this.store.notificationRules.list()) {
      if (rule.enabled && rule.events.includes('weekly_digest')) await this.enqueue({ ruleId: rule.id, event: 'weekly_digest' });
    }
  }

  async digestMessage(rule: NotificationRule): Promise<Message> {
    const now = new Date();
    const visibleTeamIds = rule.teamIds.length ? rule.teamIds : undefined;
    const [summary, breached, findings] = await Promise.all([
      this.store.tickets.summary({ visibleTeamIds, userId: '', now }),
      this.store.tickets.list({ statuses: ['open', 'triaged', 'in_progress', 'reopened'], slaBreached: true, visibleTeamIds, now, offset: 0, limit: 5 }),
      this.store.findings.summary({ visibleTeamIds, fixedSince: new Date(now.getTime() - 7 * 86_400_000) }),
    ]);
    return {
      event: 'weekly_digest',
      title: `Weekly security digest${rule.teamIds.length ? ` — ${rule.name}` : ''}`,
      summary: `${summary.active} open ticket(s), ${summary.slaBreached} past their SLA. ${findings.fixedSince} finding(s) fixed in the last 7 days.`,
      severity: summary.bySeverity.critical ? 'critical' : summary.bySeverity.high ? 'high' : null,
      url: this.link('/tickets?status=active'),
      facts: [
        ...SEVERITIES.filter((s) => summary.bySeverity[s]).map((s) => ({ name: `Open ${s}`, value: String(summary.bySeverity[s]) })),
        { name: 'Unassigned', value: String(summary.unassigned) },
        ...breached.items.map((t) => ({ name: `Overdue ${t.key}`, value: t.title.slice(0, 120) })),
      ],
    };
  }

  // ------------------------------------------------------------------ email from a ticket

  async emailTicket(ticketId: string, input: TicketEmailInput, actor: User, ctx: RequestContext): Promise<{ sent: true }> {
    const t = await this.tickets.require(ticketId, actor);
    const channel = await this.channels.require(input.channelId);
    if (!isEmailChannel(channel.type)) throw new NotFoundException('Email channel not found.');
    const repo = await this.store.repositories.findById(t.repoId);
    const note = input.message ? `${input.message}\n\n— ${actor.displayName}` : `Shared by ${actor.displayName}.`;
    await this.channels.send(channel, this.ticketMessage('ticket_email', t, repo, note), { to: input.to, cc: input.cc });
    await this.tickets.recordEvent(t.id, 'email_sent', actor, input.message || null, { channel: channel.name, to: input.to, cc: input.cc });
    await this.audit.record({ action: 'ticket.email_sent', actor, target: { type: 'ticket', id: t.id }, details: { key: t.key, channel: channel.name, to: input.to, cc: input.cc }, ip: ctx.ip });
    return { sent: true };
  }
}
