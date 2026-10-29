import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { type Credential, type DataStore, type User } from '@argus/data';
import {
  CREDENTIAL_NOTICE_DAYS,
  type CredentialDto,
  type CredentialInput,
  type CredentialUpdateInput,
  type EntraImportSettingsDto,
  type EntraImportSettingsInput,
  type ExpiringItemDto,
  hasGlobalScope,
  type ListCredentialsQuery,
  type Paged,
} from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { DomainEvents } from '../core/domain-events';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { callExternal, entraToken, IntegrationError } from '../integrations/outbound';
import { ReportsService } from '../reports/reports.service';

const DAY = 86_400_000;
const ENTRA_KEY = 'integrations.entraImport';
const NOTICE_KEY = 'credentials.lastNoticeRun';
const ENTRA_SYNC_KEY = 'credentials.lastEntraSync';
const PAGE = 500;

interface StoredEntra extends Omit<EntraImportSettingsInput, 'clientSecret'> {
  secretEnc: string | null;
  secretHint: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncCount: number | null;
}

interface GraphApp {
  appId: string;
  displayName: string | null;
  passwordCredentials?: { keyId: string; displayName: string | null; endDateTime: string | null }[];
  keyCredentials?: { keyId: string; displayName: string | null; endDateTime: string | null }[];
}

export const daysLeft = (expiresAt: Date, now: Date) => Math.floor((expiresAt.getTime() - now.getTime()) / DAY);

/** The notice due for a credential: the smallest threshold it has reached (0 once expired), if any. */
export function noticeDue(c: Pick<Credential, 'expiresAt' | 'lastNoticeDays' | 'archived'>, now: Date): number | null {
  if (c.archived) return null;
  const left = daysLeft(c.expiresAt, now);
  // Threshold 0 means "expired": it is reached only once the expiry has passed (less than a day left is the 1-day notice).
  const reached = CREDENTIAL_NOTICE_DAYS.filter((t) => (t === 0 ? c.expiresAt.getTime() <= now.getTime() : left <= t));
  if (!reached.length) return null;
  const threshold = Math.min(...reached);
  return c.lastNoticeDays === null || threshold < c.lastNoticeDays ? threshold : null;
}

/**
 * Credential inventory: tracked secrets and certificates (never their values) with expiry notices, plus a daily
 * import of Microsoft Entra ID application secrets and certificates.
 */
@Injectable()
export class CredentialsService implements OnModuleInit {
  private readonly logger = new Logger('Credentials');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    reports: ReportsService,
  ) {
    reports.credentialSource = (scope) => this.expiringForDashboard(scope);
  }

  onModuleInit(): void {
    this.events.on('scheduler.tick', async ({ now }) => {
      // Once a day each: expiry notices, then the Entra import.
      const today = now.toISOString().slice(0, 10);
      if ((await this.settings.getSystemValue<string>(NOTICE_KEY)) !== today) {
        await this.settings.setSystemValue(NOTICE_KEY, today);
        await this.sendNotices(now);
      }
      if ((await this.settings.getSystemValue<string>(ENTRA_SYNC_KEY)) !== today) {
        await this.settings.setSystemValue(ENTRA_SYNC_KEY, today);
        const s = await this.storedEntra();
        if (s?.enabled && s.secretEnc && !this.config.offline) await this.syncEntra().catch((err: unknown) => this.logger.warn(`Entra import failed: ${(err as Error).message}`));
      }
    });
  }

  // ------------------------------------------------------------------ inventory

  private visible(user: User) {
    return hasGlobalScope(user.role) ? undefined : user.teamIds;
  }

  private assertTeam(user: User, teamId: string | null) {
    const v = this.visible(user);
    if (v && (teamId === null || !v.includes(teamId))) throw new ForbiddenException('You can only manage credentials of your own teams.');
  }

  private async toDto(c: Credential, teamNames?: Map<string, string>): Promise<CredentialDto> {
    const teamName = c.teamId ? (teamNames?.get(c.teamId) ?? (await this.store.teams.findById(c.teamId))?.name ?? null) : null;
    const { lastNoticeDays: _n, createdBy: _b, ...rest } = c;
    return { ...rest, expiresAt: c.expiresAt.toISOString(), daysLeft: daysLeft(c.expiresAt, new Date()), teamName, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() };
  }

  async list(q: ListCredentialsQuery, user: User): Promise<Paged<CredentialDto>> {
    const page = await this.store.credentials.list({
      visibleTeamIds: this.visible(user),
      teamId: q.teamId,
      search: q.search || undefined,
      archived: q.archived ?? false,
      expiresBefore: q.expiringWithinDays !== undefined ? new Date(Date.now() + q.expiringWithinDays * DAY) : undefined,
      offset: (q.page - 1) * q.pageSize,
      limit: q.pageSize,
    });
    const teams = new Map((await this.store.teams.findByIds([...new Set(page.items.map((c) => c.teamId).filter((x): x is string => !!x))])).map((t) => [t.id, t.name]));
    return { items: await Promise.all(page.items.map((c) => this.toDto(c, teams))), total: page.total, page: q.page, pageSize: q.pageSize };
  }

  private async require(id: string, user: User): Promise<Credential> {
    const c = await this.store.credentials.findById(id);
    const v = this.visible(user);
    if (!c || (v && (c.teamId === null || !v.includes(c.teamId)))) throw new NotFoundException('Credential not found.');
    return c;
  }

  async create(input: CredentialInput, actor: User, ctx: RequestContext): Promise<CredentialDto> {
    this.assertTeam(actor, input.teamId);
    if (input.teamId && !(await this.store.teams.findById(input.teamId))) throw new BadRequestException('The team does not exist.');
    const c = await this.store.credentials.create({ ...input, source: 'manual', externalId: null, archived: false, createdBy: actor.id });
    await this.audit.record({ action: 'credential.created', actor, target: { type: 'credential', id: c.id }, details: { name: c.name, kind: c.kind, system: c.system, expiresAt: c.expiresAt.toISOString() }, ip: ctx.ip });
    return this.toDto(c);
  }

  async update(id: string, input: CredentialUpdateInput, actor: User, ctx: RequestContext): Promise<CredentialDto> {
    const c = await this.require(id, actor);
    if (input.teamId !== undefined) this.assertTeam(actor, input.teamId);
    // Imported credentials follow their source; only local fields can change.
    const patch = c.source === 'manual' ? { ...input } : { teamId: input.teamId, owner: input.owner, notes: input.notes, notifyEmails: input.notifyEmails, archived: input.archived };
    // A renewed credential (new expiry) gets its notices again.
    const renewed = patch && 'expiresAt' in patch && patch.expiresAt && patch.expiresAt.getTime() !== c.expiresAt.getTime();
    const updated = (await this.store.credentials.update(id, { ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), ...(renewed ? { lastNoticeDays: null } : {}) }))!;
    await this.audit.record({ action: 'credential.updated', actor, target: { type: 'credential', id }, details: { name: updated.name, changed: Object.keys(input), renewed: !!renewed }, ip: ctx.ip });
    return this.toDto(updated);
  }

  async remove(id: string, actor: User, ctx: RequestContext): Promise<void> {
    const c = await this.require(id, actor);
    if (c.source !== 'manual') throw new BadRequestException('Imported credentials cannot be deleted; archive them instead, or remove them at the source.');
    await this.store.credentials.delete(id);
    await this.audit.record({ action: 'credential.deleted', actor, target: { type: 'credential', id }, details: { name: c.name }, ip: ctx.ip });
  }

  private async allActive(): Promise<Credential[]> {
    const out: Credential[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.store.credentials.list({ archived: false, offset, limit: PAGE });
      out.push(...page.items);
      if (page.items.length < PAGE) return out;
    }
  }

  private async expiringForDashboard(scope: { visibleTeamIds?: string[]; teamId?: string; now: Date }): Promise<ExpiringItemDto[]> {
    const page = await this.store.credentials.list({ visibleTeamIds: scope.visibleTeamIds, teamId: scope.teamId, archived: false, expiresBefore: new Date(scope.now.getTime() + 181 * DAY), offset: 0, limit: 200 });
    return page.items.map((c) => ({ kind: 'credential', title: c.name, repoId: null, location: c.system || null, expiresAt: c.expiresAt.toISOString(), daysLeft: daysLeft(c.expiresAt, scope.now) }));
  }

  /** Raises one notice per threshold reached (30, 14, 7, 1 days, expired) through notification rules. */
  async sendNotices(now: Date): Promise<number> {
    let sent = 0;
    for (const c of await this.allActive()) {
      const due = noticeDue(c, now);
      if (due === null) continue;
      await this.store.credentials.update(c.id, { lastNoticeDays: due });
      await this.events.emit('credential.expiring', { credential: c, daysLeft: daysLeft(c.expiresAt, now) });
      sent++;
    }
    return sent;
  }

  // ------------------------------------------------------------------ Entra ID import

  private async storedEntra(): Promise<StoredEntra | null> {
    return (await this.store.settings.get<StoredEntra>(ENTRA_KEY))?.value ?? null;
  }

  async getEntraSettings(): Promise<EntraImportSettingsDto | null> {
    const s = await this.storedEntra();
    if (!s) return null;
    const { secretEnc, ...rest } = s;
    return { ...rest, secretConfigured: !!secretEnc };
  }

  async updateEntraSettings(input: EntraImportSettingsInput, actor: User, ctx: RequestContext): Promise<EntraImportSettingsDto> {
    const current = await this.storedEntra();
    if (!input.clientSecret && !current?.secretEnc) throw new BadRequestException('The client secret is required.');
    const { clientSecret, ...rest } = input;
    const value: StoredEntra = {
      ...rest,
      secretEnc: clientSecret ? this.crypto.encrypt(clientSecret) : current!.secretEnc,
      secretHint: clientSecret ? `••••${clientSecret.slice(-4)}` : current!.secretHint,
      lastSyncAt: current?.lastSyncAt ?? null,
      lastSyncError: current?.lastSyncError ?? null,
      lastSyncCount: current?.lastSyncCount ?? null,
    };
    await this.store.settings.set(ENTRA_KEY, value, actor.id);
    await this.audit.record({ action: 'integration.entra_import_updated', actor, details: { enabled: value.enabled, tenantId: value.tenantId, clientId: value.clientId, secretRotated: !!clientSecret }, ip: ctx.ip });
    return (await this.getEntraSettings())!;
  }

  /** Imports every application's client secrets and certificates; ones removed in Entra are archived. */
  async syncEntra(actor?: User): Promise<EntraImportSettingsDto> {
    const s = await this.storedEntra();
    if (!s?.secretEnc) throw new BadRequestException('The Entra ID import is not configured.');
    if (this.config.offline) throw new BadRequestException('Argus runs in offline mode (ARGUS_OFFLINE=true).');
    let count = 0;
    let error: string | null = null;
    try {
      const token = await entraToken(this.config.microsoft.login, s.tenantId, s.clientId, this.crypto.decrypt(s.secretEnc), `${this.config.microsoft.graph}/.default`);
      const origin = new URL(this.config.microsoft.graph).origin;
      const apps: GraphApp[] = [];
      let url: string | null = `${this.config.microsoft.graph}/v1.0/applications?$select=appId,displayName,passwordCredentials,keyCredentials&$top=999`;
      while (url) {
        // Paging links must stay on Graph, so the token is never sent elsewhere.
        if (new URL(url).origin !== origin) throw new IntegrationError('Microsoft Graph returned a paging link to another host.');
        const res = await callExternal(url, { service: 'Microsoft Graph', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
        const body = (await res.json()) as { value: GraphApp[]; '@odata.nextLink'?: string };
        apps.push(...body.value);
        url = body['@odata.nextLink'] ?? null;
      }
      const existing = new Map((await this.store.credentials.listBySource('entra')).map((c) => [c.externalId!, c]));
      const seen = new Set<string>();
      for (const app of apps) {
        const items = [...(app.passwordCredentials ?? []).map((k) => ({ ...k, kind: 'client_secret' as const })), ...(app.keyCredentials ?? []).map((k) => ({ ...k, kind: 'certificate' as const }))];
        for (const k of items) {
          if (!k.endDateTime) continue;
          const externalId = `${app.appId}:${k.keyId}`;
          seen.add(externalId);
          const expiresAt = new Date(k.endDateTime);
          const name = `${app.displayName ?? app.appId} — ${k.displayName || (k.kind === 'certificate' ? 'certificate' : 'client secret')}`;
          const prev = existing.get(externalId);
          if (!prev) {
            await this.store.credentials.create({ name, kind: k.kind, system: 'Microsoft Entra ID', owner: '', teamId: s.teamId, expiresAt, notes: `Application (client) id ${app.appId}`, notifyEmails: [], source: 'entra', externalId, archived: false, createdBy: null });
          } else {
            const renewed = prev.expiresAt.getTime() !== expiresAt.getTime();
            if (renewed || prev.name !== name || prev.archived) await this.store.credentials.update(prev.id, { name, expiresAt, archived: false, ...(renewed ? { lastNoticeDays: null } : {}) });
          }
          count++;
        }
      }
      for (const [externalId, c] of existing) if (!seen.has(externalId) && !c.archived) await this.store.credentials.update(c.id, { archived: true });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const now = new Date().toISOString();
    await this.store.settings.set(ENTRA_KEY, { ...s, lastSyncAt: now, lastSyncError: error, lastSyncCount: error ? s.lastSyncCount : count }, actor?.id ?? null);
    await this.audit.record({ action: 'integration.entra_import_synced', actor: actor ?? null, outcome: error ? 'failure' : 'success', details: { credentials: count, error } });
    return (await this.getEntraSettings())!;
  }
}
