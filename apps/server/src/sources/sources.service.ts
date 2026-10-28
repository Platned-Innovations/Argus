import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { type DataStore, type Job, type Source, type SourceWithCounts } from '@argus/data';
import { type SourceCreateInput, type SourceDto, type SourceTestInput, type SourceTestResult, type SourceUpdateInput, type SourceWithSecretDto } from '@argus/shared';
import { Redactor } from '../common/redact';
import { type RequestContext } from '../common/request';
import { AuditService, type AuditActor } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { DATA_STORE } from '../core/tokens';
import { JobRunner, PermanentJobError } from '../jobs/job-runner.service';
import { compilePatterns, DEFAULT_SCHEDULE } from '../scans/schedule';
import { createProviderClient, type ProviderClient, type ProviderConnection, ProviderError } from './providers';

export const SOURCE_SYNC_JOB = 'source.sync';

function toDto(s: Source | SourceWithCounts): SourceDto {
  return {
    id: s.id,
    name: s.name,
    provider: s.provider,
    baseUrl: s.baseUrl,
    scope: s.scope,
    username: s.username,
    tokenHint: `••••${s.tokenLast4}`,
    autoActivatePattern: s.autoActivatePattern,
    defaultTeamId: s.defaultTeamId,
    status: s.status,
    lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
    lastSyncError: s.lastSyncError,
    repoCount: 'repoCount' in s ? s.repoCount : 0,
    activeRepoCount: 'activeRepoCount' in s ? s.activeRepoCount : 0,
    webhookPath: `/api/v1/webhooks/${s.id}`,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

const nullIfEmpty = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

@Injectable()
export class SourcesService implements OnModuleInit {
  private readonly logger = new Logger('Sources');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly runner: JobRunner,
  ) {}

  onModuleInit(): void {
    this.runner.register(SOURCE_SYNC_JOB, (job) => this.runSync(job));
  }

  async list(): Promise<SourceDto[]> {
    return (await this.store.sources.list()).map(toDto);
  }

  async summaries(): Promise<Pick<SourceDto, 'id' | 'name' | 'provider'>[]> {
    return (await this.store.sources.list()).map((s) => ({ id: s.id, name: s.name, provider: s.provider }));
  }

  async get(id: string): Promise<SourceDto> {
    const s = (await this.store.sources.list()).find((x) => x.id === id);
    if (!s) throw new NotFoundException('Source not found.');
    return toDto(s);
  }

  async require(id: string): Promise<Source> {
    const s = await this.store.sources.findById(id);
    if (!s) throw new NotFoundException('Source not found.');
    return s;
  }

  /** Builds an API client with the decrypted token. The token never leaves this process. */
  clientFor(source: Source): ProviderClient {
    return createProviderClient(this.connection(source));
  }

  connection(source: Source): ProviderConnection {
    return { provider: source.provider, baseUrl: source.baseUrl, scope: source.scope, username: source.username, token: this.crypto.decrypt(source.tokenEnc) };
  }

  decryptWebhookSecret(source: Source): string {
    return this.crypto.decrypt(source.webhookSecretEnc);
  }

  async test(input: SourceTestInput): Promise<SourceTestResult> {
    const conn: ProviderConnection = { provider: input.provider, baseUrl: nullIfEmpty(input.baseUrl), scope: nullIfEmpty(input.scope), username: nullIfEmpty(input.username), token: input.token };
    try {
      const res = await createProviderClient(conn).check();
      return { ok: true, identity: res.identity, visibleRepos: res.visibleRepos, message: null };
    } catch (err) {
      return { ok: false, identity: null, visibleRepos: null, message: new Redactor([input.token]).redact(err instanceof Error ? err.message : String(err)) };
    }
  }

  async testExisting(id: string): Promise<SourceTestResult> {
    const s = await this.require(id);
    return this.test({ ...this.connection(s) });
  }

  async create(input: SourceCreateInput, actor: AuditActor, ctx: RequestContext): Promise<SourceWithSecretDto> {
    await this.assertTeam(input.defaultTeamId);
    const conn = { provider: input.provider, baseUrl: nullIfEmpty(input.baseUrl), scope: nullIfEmpty(input.scope), username: nullIfEmpty(input.username), token: input.token };
    const check = await this.test(conn);
    if (!check.ok) throw new BadRequestException({ statusCode: 400, message: check.message ?? 'Connection test failed.', code: 'SOURCE_CONNECTION_FAILED' });

    const webhookSecret = this.crypto.randomToken(32);
    const source = await this.store.sources.create({
      name: input.name,
      provider: conn.provider,
      baseUrl: conn.baseUrl,
      scope: conn.scope,
      username: conn.username,
      tokenEnc: this.crypto.encrypt(input.token),
      tokenLast4: input.token.slice(-4),
      webhookSecretEnc: this.crypto.encrypt(webhookSecret),
      autoActivatePattern: nullIfEmpty(input.autoActivatePattern),
      defaultTeamId: input.defaultTeamId ?? null,
    });
    await this.audit.record({
      action: 'source.created',
      actor,
      target: { type: 'source', id: source.id },
      details: { name: source.name, provider: source.provider, baseUrl: source.baseUrl, scope: source.scope },
      ip: ctx.ip,
    });
    await this.enqueueSync(source.id);
    return { source: toDto(source), webhookSecret };
  }

  async update(id: string, input: SourceUpdateInput, actor: AuditActor, ctx: RequestContext): Promise<SourceDto> {
    const current = await this.require(id);
    if (input.defaultTeamId !== undefined) await this.assertTeam(input.defaultTeamId);
    const next = {
      name: input.name ?? current.name,
      baseUrl: input.baseUrl !== undefined ? nullIfEmpty(input.baseUrl) : current.baseUrl,
      scope: input.scope !== undefined ? nullIfEmpty(input.scope) : current.scope,
      username: input.username !== undefined ? nullIfEmpty(input.username) : current.username,
    };
    const connectionChanged = input.token !== undefined || next.baseUrl !== current.baseUrl || next.scope !== current.scope || next.username !== current.username;
    const token = input.token ?? this.crypto.decrypt(current.tokenEnc);
    if (connectionChanged) {
      const check = await this.test({ provider: current.provider, ...next, token });
      if (!check.ok) throw new BadRequestException({ statusCode: 400, message: check.message ?? 'Connection test failed.', code: 'SOURCE_CONNECTION_FAILED' });
    }
    const updated = (await this.store.sources.update(id, {
      ...next,
      ...(input.token !== undefined ? { tokenEnc: this.crypto.encrypt(input.token), tokenLast4: input.token.slice(-4) } : {}),
      ...(input.autoActivatePattern !== undefined ? { autoActivatePattern: nullIfEmpty(input.autoActivatePattern) } : {}),
      ...(input.defaultTeamId !== undefined ? { defaultTeamId: input.defaultTeamId } : {}),
    }))!;
    await this.audit.record({
      action: 'source.updated',
      actor,
      target: { type: 'source', id },
      details: { changed: Object.keys(input).filter((k) => k !== 'token'), tokenRotated: input.token !== undefined },
      ip: ctx.ip,
    });
    if (connectionChanged) await this.enqueueSync(id);
    return this.get(updated.id);
  }

  async remove(id: string, actor: AuditActor, ctx: RequestContext): Promise<void> {
    const s = await this.require(id);
    await this.store.sources.delete(id);
    await this.audit.record({ action: 'source.deleted', actor, target: { type: 'source', id }, details: { name: s.name, provider: s.provider }, ip: ctx.ip });
  }

  async rotateWebhookSecret(id: string, actor: AuditActor, ctx: RequestContext): Promise<SourceWithSecretDto> {
    await this.require(id);
    const webhookSecret = this.crypto.randomToken(32);
    await this.store.sources.update(id, { webhookSecretEnc: this.crypto.encrypt(webhookSecret) });
    await this.audit.record({ action: 'source.webhook_secret_rotated', actor, target: { type: 'source', id }, ip: ctx.ip });
    return { source: await this.get(id), webhookSecret };
  }

  async requestSync(id: string, actor: AuditActor, ctx: RequestContext): Promise<{ queued: boolean }> {
    await this.require(id);
    const queued = await this.enqueueSync(id, 5);
    await this.audit.record({ action: 'source.sync_requested', actor, target: { type: 'source', id }, ip: ctx.ip });
    return { queued };
  }

  async enqueueSync(sourceId: string, priority = 0): Promise<boolean> {
    const job = await this.store.jobs.enqueue({ type: SOURCE_SYNC_JOB, payload: { sourceId }, dedupeKey: `sync:${sourceId}`, priority, maxAttempts: 2 });
    this.runner.poke();
    return job !== null;
  }

  /** Job handler: refresh the repository list from the provider. */
  private async runSync(job: Job): Promise<void> {
    const source = await this.store.sources.findById(String(job.payload.sourceId));
    if (!source) return;
    const conn = this.connection(source);
    try {
      const discovered = await createProviderClient(conn).listRepositories();
      const matches = compilePatterns(source.autoActivatePattern);
      const result = await this.store.repositories.syncFromSource(source.id, discovered, {
        activate: (r) => matches(r.fullName),
        teamId: source.defaultTeamId,
        schedule: DEFAULT_SCHEDULE,
        firstScanAt: new Date(),
      });
      await this.store.sources.update(source.id, { status: 'ok', lastSyncAt: new Date(), lastSyncError: null });
      this.logger.log(`Synced source ${source.name}: ${discovered.length} repositories (+${result.added} / ~${result.updated} / -${result.removed})`);
      if (result.added || result.removed || result.activated.length) {
        await this.audit.record({
          action: 'source.synced',
          target: { type: 'source', id: source.id },
          details: { repositories: discovered.length, added: result.added, removed: result.removed, autoActivated: result.activated.length },
        });
      }
    } catch (err) {
      const message = new Redactor([conn.token]).redact(err instanceof Error ? err.message : String(err));
      await this.store.sources.update(source.id, { status: 'error', lastSyncError: message.slice(0, 1000) });
      if (err instanceof ProviderError && err.permanent) throw new PermanentJobError(message);
      throw new Error(message);
    }
  }

  private async assertTeam(teamId: string | null | undefined): Promise<void> {
    if (teamId && !(await this.store.teams.findById(teamId))) throw new BadRequestException('The default team does not exist.');
  }
}
