import { BadRequestException, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type DataStore, type Repository, type Ticket, type User } from '@argus/data';
import { type ConnectionTestDto, type JiraSettingsDto, type JiraSettingsInput, TICKET_STATUS_LABELS } from '@argus/shared';
import { Redactor } from '../common/redact';
import { type RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { DomainEvents } from '../core/domain-events';
import { DATA_STORE } from '../core/tokens';
import { TicketsService } from '../tickets/tickets.service';
import { isActive } from '../tickets/ticket-rules';
import { callExternal, IntegrationError } from './outbound';

const SETTINGS_KEY = 'integrations.jira';
const SYNC_INTERVAL_MS = 15 * 60_000;

interface StoredJira extends Omit<JiraSettingsInput, 'token'> {
  tokenEnc: string | null;
  tokenHint: string | null;
}

/** Atlassian Document Format for Jira Cloud (REST v3); plain paragraphs keep it simple and safe. */
function adf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: p.trim() ? [{ type: 'text', text: p.trim() }] : [] })),
  };
}

@Injectable()
export class JiraService implements OnModuleInit {
  private readonly logger = new Logger('Jira');
  private lastSync = 0;

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly tickets: TicketsService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.events.on('scheduler.tick', async ({ now }) => {
      if (now.getTime() - this.lastSync < SYNC_INTERVAL_MS) return;
      this.lastSync = now.getTime();
      await this.syncAll();
    });
  }

  private async stored(): Promise<StoredJira | null> {
    return (await this.store.settings.get<StoredJira>(SETTINGS_KEY))?.value ?? null;
  }

  async getSettings(): Promise<JiraSettingsDto | null> {
    const s = await this.stored();
    if (!s) return null;
    const { tokenEnc, tokenHint, ...rest } = s;
    return { ...rest, tokenConfigured: !!tokenEnc, tokenHint };
  }

  async updateSettings(input: JiraSettingsInput, actor: User, ctx: RequestContext): Promise<JiraSettingsDto> {
    const current = await this.stored();
    if (!input.token && !current?.tokenEnc) throw new BadRequestException('The API token is required.');
    if (input.deployment === 'cloud' && !input.email) throw new BadRequestException('Jira Cloud needs the email address of the account that owns the API token.');
    const { token, ...rest } = input;
    const value: StoredJira = {
      ...rest,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      tokenEnc: token ? this.crypto.encrypt(token) : current!.tokenEnc,
      tokenHint: token ? `••••${token.slice(-4)}` : current!.tokenHint,
    };
    await this.store.settings.set(SETTINGS_KEY, value, actor.id);
    await this.audit.record({ action: 'integration.jira_updated', actor, details: { enabled: value.enabled, deployment: value.deployment, baseUrl: value.baseUrl, tokenRotated: !!token }, ip: ctx.ip });
    return (await this.getSettings())!;
  }

  private async client(requireEnabled = true) {
    const s = await this.stored();
    if (!s || !s.tokenEnc) throw new BadRequestException('Jira is not configured. An administrator can set it up under Administration → Integrations.');
    if (requireEnabled && !s.enabled) throw new BadRequestException('The Jira integration is turned off.');
    const token = this.crypto.decrypt(s.tokenEnc);
    const api = `${s.baseUrl}/rest/api/${s.deployment === 'cloud' ? '3' : '2'}`;
    const authorization = s.deployment === 'cloud' ? `Basic ${Buffer.from(`${s.email}:${token}`).toString('base64')}` : `Bearer ${token}`;
    const redactor = new Redactor([token]);
    const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      try {
        const res = await callExternal(`${api}${path}`, { ...init, service: 'Jira', headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
        return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
      } catch (err) {
        const status = err instanceof IntegrationError ? err.status : null;
        const hintText = status === 401 ? ' Check the email address and API token.' : status === 403 ? ' The account lacks permission (e.g. Create Issues in that project).' : status === 404 ? ' Check the project key and the server URL.' : '';
        throw new IntegrationError(redactor.redact(`${err instanceof Error ? err.message : String(err)}${hintText}`), status);
      }
    };
    return { settings: s, call };
  }

  async test(): Promise<ConnectionTestDto> {
    try {
      const { call } = await this.client(false);
      const me = await call<{ displayName?: string; name?: string }>('/myself');
      return { ok: true, message: `Connected as ${me.displayName ?? me.name ?? 'unknown user'}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private describe(t: Ticket, repo: Repository | null): string {
    const url = this.config.publicUrl ? `${this.config.publicUrl}/tickets/${t.id}` : null;
    return [
      t.description ?? t.title,
      `Repository: ${repo?.fullName ?? t.repoId}\nSeverity: ${t.severity} (risk score ${t.riskScore})\nArgus ticket: ${t.key}${url ? ` — ${url}` : ''}`,
      t.remediation ? `How to fix: ${t.remediation}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  async createIssue(ticketId: string, input: { projectKey?: string; issueType?: string; summary?: string; description?: string }, actor: User, ctx: RequestContext) {
    const t = await this.tickets.require(ticketId, actor);
    this.tickets.assertNoJira(t);
    const repo = await this.store.repositories.findById(t.repoId);
    const projectKey = input.projectKey ?? repo?.jiraProjectKey;
    if (!projectKey) throw new BadRequestException('Choose a Jira project, or set one on the repository.');
    const { settings, call } = await this.client();
    const description = input.description ?? this.describe(t, repo);
    const created = await call<{ key: string }>('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary: `[${t.key}] ${input.summary ?? t.title}`.slice(0, 250),
          issuetype: { name: input.issueType ?? settings.defaultIssueType },
          description: settings.deployment === 'cloud' ? adf(description) : description,
          labels: ['argus', ...(settings.label ? [settings.label] : [])],
        },
      }),
    });
    const url = `${settings.baseUrl}/browse/${created.key}`;
    await this.store.tickets.update(t.id, { jira: { key: created.key, url, status: null, statusCategory: null, syncedAt: null } });
    await this.tickets.recordEvent(t.id, 'jira_created', actor, null, { key: created.key, url, projectKey });
    await this.audit.record({ action: 'ticket.jira_created', actor, target: { type: 'ticket', id: t.id }, details: { key: t.key, jiraKey: created.key }, ip: ctx.ip });
    await this.syncTicket((await this.store.tickets.findById(t.id))!).catch(() => undefined);
    return { key: created.key, url };
  }

  /** Mirrors the Jira status. When Jira says done, an active ticket becomes resolved; the next scan verifies the fix. */
  async syncTicket(t: Ticket): Promise<void> {
    if (!t.jira) return;
    const { call } = await this.client();
    const issue = await call<{ fields: { status: { name: string; statusCategory?: { key: string } } } }>(`/issue/${encodeURIComponent(t.jira.key)}?fields=status`);
    const status = issue.fields.status.name;
    const category = issue.fields.status.statusCategory?.key ?? null;
    const changed = status !== t.jira.status;
    await this.store.tickets.update(t.id, { jira: { ...t.jira, status, statusCategory: category, syncedAt: new Date() }, lastActivityAt: t.lastActivityAt });
    if (!changed) return;
    await this.tickets.recordEvent(t.id, 'jira_status', null, null, { key: t.jira.key, status, category });
    if (category === 'done' && isActive(t.status)) {
      await this.store.tickets.update(t.id, { status: 'resolved', resolvedAt: new Date() });
      await this.tickets.recordEvent(t.id, 'status', null, `${t.jira.key} is ${status} in Jira. The next scan verifies the fix.`, { from: t.status, to: 'resolved', label: TICKET_STATUS_LABELS.resolved });
    }
  }

  async syncAll(): Promise<void> {
    const s = await this.stored();
    if (!s?.enabled || !s.tokenEnc) return;
    for (const t of await this.store.tickets.listJiraLinked(500)) {
      try {
        await this.syncTicket(t);
      } catch (err) {
        this.logger.warn(`Jira sync failed for ${t.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
