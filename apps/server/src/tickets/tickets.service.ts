import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { type DataStore, type Finding, type Repository, type Ticket, type TicketEvent, type TicketPatch, type User } from '@argus/data';
import {
  type AssigneeDto,
  hasGlobalScope,
  hasPermission,
  type ListTicketsQuery,
  type Paged,
  type TicketBulkInput,
  type TicketDetailDto,
  type TicketDto,
  type TicketEventDto,
  type TicketEventType,
  TICKET_STATUS_LABELS,
  type TicketStatusInput,
  type TicketSummaryDto,
  type TicketUpdateInput,
  TRIAGE_ONLY_STATUSES,
  ACTIVE_TICKET_STATUSES,
} from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
import { DomainEvents } from '../core/domain-events';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { FindingsService } from '../findings/findings.service';
import { csvCell } from '../audit/audit.controller';
import { groupKeyFor } from '../scanning/group-key';
import { visibleTeams } from '../scans/scans.service';
import { decideStatus, isActive, leadFinding, severityRank, slaDueAt, ticketTitle } from './ticket-rules';

const SYSTEM = { actorId: null, actorName: 'Argus' };
const EXPORT_LIMIT = 10_000;
const SLA_CHECK_MS = 5 * 60_000;

export interface Actor {
  id: string;
  displayName: string;
}

@Injectable()
export class TicketsService implements OnModuleInit {
  private readonly logger = new Logger('Tickets');
  private lastSlaCheck = 0;

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly settings: SettingsService,
    private readonly findings: FindingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit(): void {
    this.events.on('scan.completed', ({ repo }) => this.syncRepo(repo, true).then(() => undefined));
    this.events.on('findings.changed', async ({ repoIds }) => {
      for (const id of repoIds) {
        const repo = await this.store.repositories.findById(id);
        if (repo) await this.syncRepo(repo, false);
      }
    });
    this.events.on('scheduler.tick', ({ now }) => this.checkSla(now));
  }

  // ------------------------------------------------------------------ automation

  /**
   * Brings the repository's tickets in line with its findings: opens tickets for new issues at or above the
   * auto-create threshold, links findings, refreshes severity and SLA, and resolves / accepts / reopens tickets.
   */
  async syncRepo(repo: Repository, afterScan: boolean): Promise<{ created: number; resolved: number; reopened: number }> {
    const settings = await this.settings.getTicketing();
    const minRank = severityRank(settings.autoCreateMinSeverity);
    const [findings, tickets] = await Promise.all([this.store.findings.listAllForRepo(repo.id), this.store.tickets.listForRepo(repo.id)]);
    const byGroup = new Map<string, Finding[]>();
    for (const f of findings) {
      const key = groupKeyFor(f);
      byGroup.set(key, [...(byGroup.get(key) ?? []), f]);
    }
    const ticketByGroup = new Map(tickets.map((t) => [t.groupKey, t]));
    const stats = { created: 0, resolved: 0, reopened: 0 };
    const now = new Date();

    for (const [groupKey, group] of byGroup) {
      const open = group.filter((f) => f.status === 'open');
      const counts = { open: open.length, suppressed: group.filter((f) => f.status === 'suppressed').length, total: group.length };
      const lead = leadFinding(group);
      let ticket = ticketByGroup.get(groupKey);

      if (!ticket) {
        if (!open.length || severityRank(lead.severity) < minRank) continue;
        ticket = await this.store.tickets.create({
          key: `ARG-${await this.store.counters.next('ticket')}`,
          repoId: repo.id,
          sourceId: repo.sourceId,
          teamId: repo.teamId,
          scanner: lead.scanner,
          groupKey,
          title: ticketTitle(group).slice(0, 500),
          description: lead.description,
          severity: lead.severity,
          riskScore: lead.riskScore,
          status: 'open',
          assigneeId: null,
          watcherIds: [],
          labels: [],
          findingIds: group.map((f) => f.id),
          openFindings: open.length,
          remediation: lead.remediation,
          dueAt: slaDueAt(now, lead.severity, settings),
          slaBreachedAt: null,
          suppressionId: null,
          jira: null,
          resolvedAt: null,
          closedAt: null,
        });
        await this.store.findings.setTicket(group.map((f) => f.id), ticket.id);
        await this.event(ticket.id, 'created', SYSTEM, null, { findings: group.length, severity: lead.severity, riskScore: lead.riskScore });
        stats.created++;
        await this.events.emit('ticket.created', { ticket });
        continue;
      }

      const unlinked = group.filter((f) => f.ticketId !== ticket!.id).map((f) => f.id);
      if (unlinked.length) await this.store.findings.setTicket(unlinked, ticket.id);

      const patch: TicketPatch = {};
      const findingIds = group.map((f) => f.id);
      if (findingIds.join() !== ticket.findingIds.join()) patch.findingIds = findingIds;
      if (open.length !== ticket.openFindings) patch.openFindings = open.length;
      if (open.length) {
        // Severity follows the open findings; an escalation tightens the deadline.
        if (lead.riskScore !== ticket.riskScore) patch.riskScore = lead.riskScore;
        if (lead.severity !== ticket.severity) {
          patch.severity = lead.severity;
          const tighter = slaDueAt(ticket.createdAt, lead.severity, settings);
          if (!ticket.dueAt || tighter < ticket.dueAt) patch.dueAt = tighter;
        }
        const title = ticketTitle(group).slice(0, 500);
        if (title !== ticket.title) patch.title = title;
      }

      const decision = decideStatus(ticket.status, counts, afterScan);
      if (decision.change) {
        patch.status = decision.status;
        if (decision.change === 'auto_resolved') patch.resolvedAt = now;
        if (decision.change === 'reopened') {
          Object.assign(patch, { resolvedAt: null, closedAt: null, suppressionId: null, slaBreachedAt: null, dueAt: slaDueAt(now, patch.severity ?? ticket.severity, settings) });
        }
      }
      if (!Object.keys(patch).length) continue;
      // Automatic updates do not count as user activity.
      const updated = (await this.store.tickets.update(ticket.id, { ...patch, lastActivityAt: decision.change ? now : ticket.lastActivityAt }))!;
      if (unlinked.length && !decision.change) await this.event(ticket.id, 'findings', SYSTEM, null, { added: unlinked.length });
      if (decision.change === 'auto_resolved') {
        stats.resolved++;
        await this.event(ticket.id, 'auto_resolved', SYSTEM, 'All findings are fixed: verified by the latest scan.', { from: ticket.status });
      } else if (decision.change === 'auto_accepted') {
        await this.event(ticket.id, 'status', SYSTEM, 'All remaining findings are covered by suppressions.', { from: ticket.status, to: 'risk_accepted' });
      } else if (decision.change === 'reopened') {
        stats.reopened++;
        const why = ticket.status === 'risk_accepted' || ticket.status === 'false_positive' ? 'Its suppression expired or was removed.' : 'The latest scan still detects the issue.';
        await this.event(ticket.id, 'reopened', SYSTEM, why, { from: ticket.status, openFindings: open.length });
        await this.events.emit('ticket.reopened', { ticket: updated });
      }
    }
    if (stats.created || stats.resolved || stats.reopened) this.logger.log(`${repo.fullName}: ${stats.created} ticket(s) opened, ${stats.resolved} resolved, ${stats.reopened} reopened`);
    return stats;
  }

  /** Flags active tickets that passed their due date (once each) and notifies. */
  async checkSla(now: Date): Promise<void> {
    if (now.getTime() - this.lastSlaCheck < SLA_CHECK_MS) return;
    this.lastSlaCheck = now.getTime();
    for (const t of await this.store.tickets.findNewlyOverdue(now, 500)) {
      const updated = (await this.store.tickets.update(t.id, { slaBreachedAt: now, lastActivityAt: t.lastActivityAt }))!;
      await this.event(t.id, 'sla_breached', SYSTEM, `The ${t.severity} SLA expired on ${t.dueAt!.toISOString().slice(0, 10)}.`, null);
      await this.events.emit('ticket.sla_breached', { ticket: updated });
    }
  }

  // ------------------------------------------------------------------ queries

  private canSee(user: User, t: Ticket): boolean {
    const teams = visibleTeams(user);
    return !teams || (t.teamId !== null && teams.includes(t.teamId));
  }

  async require(id: string, user: User): Promise<Ticket> {
    const t = await this.store.tickets.findById(id);
    if (!t || !this.canSee(user, t)) throw new NotFoundException('Ticket not found.');
    return t;
  }

  private async names(tickets: Ticket[]) {
    const [repos, users] = await Promise.all([
      this.store.repositories.findByIds([...new Set(tickets.map((t) => t.repoId))]),
      Promise.all([...new Set(tickets.map((t) => t.assigneeId).filter((x): x is string => !!x))].map((id) => this.store.users.findById(id))),
    ]);
    return { repos: new Map(repos.map((r) => [r.id, r.fullName])), users: new Map(users.filter((u): u is User => !!u).map((u) => [u.id, u.displayName])) };
  }

  toDto(t: Ticket, repoName: string | null, assigneeName: string | null, now = new Date()): TicketDto {
    return {
      id: t.id,
      key: t.key,
      repoId: t.repoId,
      repoFullName: repoName,
      teamId: t.teamId,
      scanner: t.scanner,
      title: t.title,
      description: t.description,
      severity: t.severity,
      riskScore: t.riskScore,
      status: t.status,
      assigneeId: t.assigneeId,
      assigneeName,
      watcherIds: t.watcherIds,
      labels: t.labels,
      dueAt: t.dueAt?.toISOString() ?? null,
      slaBreached: isActive(t.status) && !!t.dueAt && t.dueAt < now,
      openFindings: t.openFindings,
      totalFindings: t.findingIds.length,
      suppressionId: t.suppressionId,
      jira: t.jira ? { ...t.jira, syncedAt: t.jira.syncedAt?.toISOString() ?? null } : null,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      closedAt: t.closedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      lastActivityAt: t.lastActivityAt.toISOString(),
    };
  }

  private filterFrom(q: ListTicketsQuery, user: User) {
    return {
      statuses: q.status === 'active' ? ACTIVE_TICKET_STATUSES : q.status ? [q.status] : undefined,
      severities: q.severity,
      repoId: q.repoId,
      scanner: q.scanner,
      assigneeId: q.assignee === 'me' ? user.id : q.assignee === 'none' ? null : q.assignee,
      slaBreached: q.slaBreached,
      search: q.search || undefined,
      visibleTeamIds: visibleTeams(user),
      now: new Date(),
    };
  }

  async list(q: ListTicketsQuery, user: User): Promise<Paged<TicketDto>> {
    const page = await this.store.tickets.list({ ...this.filterFrom(q, user), offset: (q.page - 1) * q.pageSize, limit: q.pageSize });
    const n = await this.names(page.items);
    return { items: page.items.map((t) => this.toDto(t, n.repos.get(t.repoId) ?? null, t.assigneeId ? (n.users.get(t.assigneeId) ?? null) : null)), total: page.total, page: q.page, pageSize: q.pageSize };
  }

  async exportCsv(q: ListTicketsQuery, user: User, ctx: RequestContext): Promise<string> {
    const page = await this.store.tickets.list({ ...this.filterFrom(q, user), offset: 0, limit: EXPORT_LIMIT });
    const n = await this.names(page.items);
    const header = ['key', 'title', 'severity', 'risk_score', 'status', 'repository', 'assignee', 'due', 'sla_breached', 'open_findings', 'jira', 'created', 'resolved'];
    const now = new Date();
    const rows = page.items.map((t) =>
      [
        t.key,
        t.title,
        t.severity,
        t.riskScore,
        TICKET_STATUS_LABELS[t.status],
        n.repos.get(t.repoId) ?? '',
        t.assigneeId ? (n.users.get(t.assigneeId) ?? '') : '',
        t.dueAt?.toISOString() ?? '',
        isActive(t.status) && !!t.dueAt && t.dueAt < now ? 'yes' : 'no',
        t.openFindings,
        t.jira?.key ?? '',
        t.createdAt.toISOString(),
        t.resolvedAt?.toISOString() ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    await this.audit.record({ action: 'tickets.exported', actor: { id: user.id, username: user.username }, details: { rows: rows.length }, ip: ctx.ip });
    return [header.join(','), ...rows].join('\r\n');
  }

  async detail(id: string, user: User): Promise<TicketDetailDto> {
    const t = await this.require(id, user);
    const [n, events] = await Promise.all([this.names([t]), this.store.tickets.listEvents(id)]);
    return { ...this.toDto(t, n.repos.get(t.repoId) ?? null, t.assigneeId ? (n.users.get(t.assigneeId) ?? null) : null), findingIds: t.findingIds, remediation: t.remediation, events: events.map(toEventDto) };
  }

  async summary(user: User): Promise<TicketSummaryDto> {
    const s = await this.store.tickets.summary({ visibleTeamIds: visibleTeams(user), userId: user.id, now: new Date() });
    return { active: s.active, bySeverity: s.bySeverity, slaBreached: s.slaBreached, assignedToMe: s.assignedTo, unassigned: s.unassigned };
  }

  /** Users who can work a ticket: tickets:write and access to its team. */
  async assignees(id: string, user: User): Promise<AssigneeDto[]> {
    const t = await this.require(id, user);
    const out: AssigneeDto[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.store.users.list({ status: 'active', offset, limit: 500 });
      for (const u of page.items) {
        if (!hasPermission(u.role, 'tickets:write')) continue;
        if (!hasGlobalScope(u.role) && !(t.teamId && u.teamIds.includes(t.teamId))) continue;
        out.push({ id: u.id, displayName: u.displayName, username: u.username });
      }
      if (page.items.length < 500) break;
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  // ------------------------------------------------------------------ actions

  private lastEventAt = 0;

  private async event(ticketId: string, type: TicketEventType, actor: { actorId: string | null; actorName: string | null }, body: string | null, data: Record<string, unknown> | null): Promise<TicketEvent> {
    // Events are listed by time; strictly increasing timestamps keep events recorded in the same millisecond in order.
    this.lastEventAt = Math.max(Date.now(), this.lastEventAt + 1);
    return this.store.tickets.addEvent({ ticketId, type, actorId: actor.actorId, actorName: actor.actorName, body, data, createdAt: new Date(this.lastEventAt) });
  }

  async recordEvent(ticketId: string, type: TicketEventType, actor: User | null, body: string | null, data: Record<string, unknown> | null): Promise<void> {
    await this.event(ticketId, type, actor ? { actorId: actor.id, actorName: actor.displayName } : SYSTEM, body, data);
    await this.store.tickets.update(ticketId, {});
  }

  async update(id: string, input: TicketUpdateInput, actor: User, ctx: RequestContext): Promise<TicketDto> {
    const t = await this.require(id, actor);
    const patch: TicketPatch = {};
    const who = { actorId: actor.id, actorName: actor.displayName };
    if (input.assigneeId !== undefined && input.assigneeId !== t.assigneeId) {
      if (input.assigneeId) {
        if (!(await this.assignees(id, actor)).some((a) => a.id === input.assigneeId)) throw new BadRequestException('That user cannot work on this ticket.');
        if (!hasPermission(actor.role, 'tickets:triage') && input.assigneeId !== actor.id) throw new ForbiddenException('You can only assign tickets to yourself.');
      }
      patch.assigneeId = input.assigneeId;
      if (input.assigneeId && !t.watcherIds.includes(input.assigneeId)) patch.watcherIds = [...t.watcherIds, input.assigneeId];
      const name = input.assigneeId ? (await this.store.users.findById(input.assigneeId))?.displayName : null;
      await this.event(id, 'assignment', who, null, { from: t.assigneeId, to: input.assigneeId, toName: name ?? null });
    }
    if (input.labels !== undefined) {
      const labels = [...new Set(input.labels)];
      if (labels.join() !== t.labels.join()) {
        patch.labels = labels;
        await this.event(id, 'labels', who, null, { labels });
      }
    }
    const updated = Object.keys(patch).length ? (await this.store.tickets.update(id, patch))! : t;
    await this.audit.record({ action: 'ticket.updated', actor, target: { type: 'ticket', id }, details: { key: t.key, changed: Object.keys(patch) }, ip: ctx.ip });
    const n = await this.names([updated]);
    return this.toDto(updated, n.repos.get(updated.repoId) ?? null, updated.assigneeId ? (n.users.get(updated.assigneeId) ?? null) : null);
  }

  async changeStatus(id: string, input: TicketStatusInput, actor: User, ctx: RequestContext): Promise<TicketDto> {
    const t = await this.require(id, actor);
    const to = input.status;
    if (to === t.status) return (await this.detail(id, actor)) as TicketDto;
    const triage = hasPermission(actor.role, 'tickets:triage');
    if ((TRIAGE_ONLY_STATUSES.includes(to) || to === 'closed') && !triage) throw new ForbiddenException('Only security managers and administrators can close tickets, accept risks or mark false positives.');
    if ((t.status === 'risk_accepted' || t.status === 'false_positive') && !triage) throw new ForbiddenException('Only security managers and administrators can reopen an accepted risk.');
    if (to === 'reopened') throw new BadRequestException('Use "open" to reopen a ticket.');

    const accepting = TRIAGE_ONLY_STATUSES.includes(to);
    if (to === 'risk_accepted' && input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new BadRequestException('The expiry date must be in the future.');

    // The status is written first: changing the suppression below re-synchronises the ticket, which must
    // then see the new status rather than undo it.
    const now = new Date();
    const patch: TicketPatch = { status: to };
    if (to === 'resolved') patch.resolvedAt = now;
    if (to === 'closed') patch.closedAt = now;
    if (isActive(to)) Object.assign(patch, { resolvedAt: null, closedAt: null });
    if (t.suppressionId) patch.suppressionId = null;
    await this.store.tickets.update(id, patch);

    // Leaving (or replacing) an accepted state removes the suppression that kept the findings quiet.
    if (t.suppressionId) {
      await this.findings.deleteSuppression(t.suppressionId, actor, ctx).catch((err: unknown) => {
        if (!(err instanceof NotFoundException)) throw err;
      });
    }
    // Accepting a risk / false positive creates a suppression for exactly this ticket's issue, so it survives scans.
    if (accepting) {
      const label = to === 'risk_accepted' ? 'Risk accepted' : 'False positive';
      const suppression = await this.findings.createSuppression(
        { repoId: t.repoId, scanner: t.scanner, reason: `${label} on ${t.key}: ${input.reason}`, expiresAt: to === 'risk_accepted' ? (input.expiresAt ?? null) : null },
        actor,
        ctx,
        { groupKey: t.groupKey, ticketId: t.id },
      );
      await this.store.tickets.update(id, { suppressionId: suppression.id });
    }

    const updated = (await this.store.tickets.findById(id))!;
    await this.event(id, 'status', { actorId: actor.id, actorName: actor.displayName }, input.reason ?? null, { from: t.status, to, expiresAt: input.expiresAt?.toISOString() ?? null });
    await this.audit.record({ action: 'ticket.status_changed', actor, target: { type: 'ticket', id }, details: { key: t.key, from: t.status, to, reason: input.reason ?? null }, ip: ctx.ip });
    const n = await this.names([updated]);
    return this.toDto(updated, n.repos.get(updated.repoId) ?? null, updated.assigneeId ? (n.users.get(updated.assigneeId) ?? null) : null);
  }

  async comment(id: string, body: string, actor: User, data: Record<string, unknown> | null = null): Promise<TicketEventDto> {
    const t = await this.require(id, actor);
    const e = await this.event(id, 'comment', { actorId: actor.id, actorName: actor.displayName }, body, data);
    await this.store.tickets.update(id, t.watcherIds.includes(actor.id) ? {} : { watcherIds: [...t.watcherIds, actor.id] });
    return toEventDto(e);
  }

  async watch(id: string, actor: User, watching: boolean): Promise<{ watching: boolean }> {
    const t = await this.require(id, actor);
    const has = t.watcherIds.includes(actor.id);
    if (has !== watching) await this.store.tickets.update(id, { watcherIds: watching ? [...t.watcherIds, actor.id] : t.watcherIds.filter((w) => w !== actor.id), lastActivityAt: t.lastActivityAt });
    return { watching };
  }

  async bulk(input: TicketBulkInput, actor: User, ctx: RequestContext): Promise<{ updated: number }> {
    if (input.assigneeId === undefined && !input.status) throw new BadRequestException('Choose an assignee or a status.');
    let updated = 0;
    for (const id of [...new Set(input.ids)]) {
      try {
        if (input.assigneeId !== undefined) await this.update(id, { assigneeId: input.assigneeId }, actor, ctx);
        if (input.status) await this.changeStatus(id, { status: input.status }, actor, ctx);
        updated++;
      } catch (err) {
        if (err instanceof NotFoundException) continue;
        throw err;
      }
    }
    return { updated };
  }

  /** Ensures the ticket is not already linked before creating a Jira issue. */
  assertNoJira(t: Ticket): void {
    if (t.jira) throw new ConflictException(`This ticket is already linked to ${t.jira.key}.`);
  }
}

export function toEventDto(e: TicketEvent): TicketEventDto {
  return { id: e.id, ticketId: e.ticketId, type: e.type, actorId: e.actorId, actorName: e.actorName, body: e.body, data: e.data, createdAt: e.createdAt.toISOString() };
}

