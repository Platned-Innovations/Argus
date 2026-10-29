import { randomUUID } from 'node:crypto';
import { type Kysely, type Selectable, sql } from 'kysely';
import {
  type Criticality,
  type DiscoveredRepo,
  type DiscoveryDefaults,
  type Job,
  type JobStatus,
  type NewJob,
  type NewScanRun,
  type NewSource,
  type Provider,
  type Repository,
  type RepositoryListFilter,
  type RepositoryPatch,
  type RepoSchedule,
  type ScanRun,
  type ScanRunListFilter,
  type ScanRunPatch,
  type ScanStatus,
  type ScanTrigger,
  type Source,
  type SourcePatch,
  type SourceStatus,
  type SourceWithCounts,
  type SyncResult,
  type Visibility,
} from '../scanning-models';
import { type Page } from '../models';
import { type JobRepo, type LockRepo, type RepositoryRepo, type ScanRunRepo, type SourceRepo } from '../store';
import { type Database, type JobsTable, type RepositoriesTable, type ScanRunsTable, type SourcesTable } from './schema';

type Db = Kysely<Database>;

const CHUNK = 500;
const ACTIVE_JOB_STATUSES: JobStatus[] = ['queued', 'running'];

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function toSource(r: Selectable<SourcesTable>): Source {
  return { ...r, provider: r.provider as Provider, status: r.status as SourceStatus };
}

function toRepo(r: Selectable<RepositoriesTable>): Repository {
  return {
    ...r,
    visibility: r.visibility as Visibility,
    criticality: r.criticality as Criticality,
    schedule: r.schedule as RepoSchedule,
    notifyEmails: r.notifyEmails ?? [],
    disabledScanners: (r.disabledScanners ?? []) as Repository['disabledScanners'],
    aiEnabled: r.aiEnabled ?? true,
    lastScanStatus: r.lastScanStatus as ScanStatus | null,
  };
}

function toRun(r: Selectable<ScanRunsTable>): ScanRun {
  return { ...r, trigger: r.trigger as ScanTrigger, status: r.status as ScanStatus, stats: r.stats ?? null, log: r.log ?? [] };
}

function toJob(r: Selectable<JobsTable>): Job {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { activeDedupeKey, ...rest } = r;
  return { ...rest, status: r.status as JobStatus };
}

/** Provider metadata that sync keeps up to date. */
const METADATA_KEYS = ['fullName', 'name', 'htmlUrl', 'cloneUrl', 'defaultBranch', 'visibility', 'language', 'description', 'archived', 'lastPushedAt'] as const;

function metadataChanged(existing: Repository, d: DiscoveredRepo): boolean {
  if (existing.removedAt) return true;
  return METADATA_KEYS.some((k) => {
    const a = existing[k];
    const b = d[k];
    return a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime() : a !== b;
  });
}

export class PgSourceRepo implements SourceRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewSource): Promise<Source> {
    const now = new Date();
    const source: Source = { ...input, id: randomUUID(), status: 'pending', lastSyncAt: null, lastSyncError: null, createdAt: now, updatedAt: now };
    await this.db.insertInto('sources').values(source).execute();
    return source;
  }

  async findById(id: string): Promise<Source | null> {
    const r = await this.db.selectFrom('sources').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toSource(r) : null;
  }

  async list(): Promise<SourceWithCounts[]> {
    const rows = await this.db
      .selectFrom('sources')
      .selectAll('sources')
      .select((eb) => [
        eb.selectFrom('repositories').select(sql<number>`count(*)::int`.as('c')).whereRef('repositories.sourceId', '=', 'sources.id').where('repositories.removedAt', 'is', null).as('repoCount'),
        eb
          .selectFrom('repositories')
          .select(sql<number>`count(*)::int`.as('c'))
          .whereRef('repositories.sourceId', '=', 'sources.id')
          .where('repositories.removedAt', 'is', null)
          .where('repositories.active', '=', true)
          .as('activeRepoCount'),
      ])
      .orderBy('sources.name')
      .execute();
    return rows.map((r) => ({ ...toSource(r), repoCount: r.repoCount ?? 0, activeRepoCount: r.activeRepoCount ?? 0 }));
  }

  async update(id: string, patch: SourcePatch): Promise<Source | null> {
    await this.db
      .updateTable('sources')
      .set({ ...patch, updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.deleteFrom('sources').where('id', '=', id).executeTakeFirst();
    return res.numDeletedRows > 0n;
  }
}

export class PgRepositoryRepo implements RepositoryRepo {
  constructor(private readonly db: Db) {}

  async syncFromSource(sourceId: string, discovered: DiscoveredRepo[], defaults: DiscoveryDefaults): Promise<SyncResult> {
    return this.db.transaction().execute(async (trx) => {
      const existing = new Map((await trx.selectFrom('repositories').selectAll().where('sourceId', '=', sourceId).execute()).map((r) => [r.externalId, toRepo(r)]));
      const now = new Date();
      const result: SyncResult = { added: 0, updated: 0, removed: 0, activated: [] };
      const inserts: Database['repositories'][] = [];
      const seen = new Set<string>();

      for (const d of discovered) {
        if (seen.has(d.externalId)) continue;
        seen.add(d.externalId);
        const current = existing.get(d.externalId);
        if (current) {
          if (metadataChanged(current, d)) {
            await trx
              .updateTable('repositories')
              .set({ ...Object.fromEntries(METADATA_KEYS.map((k) => [k, d[k]])), removedAt: null, updatedAt: now })
              .where('id', '=', current.id)
              .execute();
            result.updated++;
          }
          continue;
        }
        const id = randomUUID();
        const active = !d.archived && defaults.activate(d);
        if (active) result.activated.push(id);
        inserts.push({
          ...d,
          id,
          sourceId,
          removedAt: null,
          active,
          teamId: defaults.teamId,
          criticality: 'medium',
          branch: null,
          schedule: JSON.stringify(defaults.schedule) as never,
          scanOnPush: true,
          jiraProjectKey: null,
          notifyEmails: '[]' as never,
          disabledScanners: '[]' as never,
          aiEnabled: true,
          nextScanAt: active ? defaults.firstScanAt : null,
          lastScanAt: null,
          lastScanStatus: null,
          lastScanRunId: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      for (let i = 0; i < inserts.length; i += CHUNK) {
        await trx
          .insertInto('repositories')
          .values(inserts.slice(i, i + CHUNK) as never)
          .execute();
      }
      result.added = inserts.length;

      const missing = [...existing.values()].filter((r) => !seen.has(r.externalId) && !r.removedAt).map((r) => r.id);
      for (let i = 0; i < missing.length; i += CHUNK) {
        await trx
          .updateTable('repositories')
          .set({ removedAt: now, active: false, nextScanAt: null, updatedAt: now })
          .where('id', 'in', missing.slice(i, i + CHUNK))
          .execute();
      }
      result.removed = missing.length;
      return result;
    });
  }

  async findById(id: string): Promise<Repository | null> {
    const r = await this.db.selectFrom('repositories').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRepo(r) : null;
  }

  async findByExternalId(sourceId: string, externalId: string): Promise<Repository | null> {
    const r = await this.db.selectFrom('repositories').selectAll().where('sourceId', '=', sourceId).where('externalId', '=', externalId).executeTakeFirst();
    return r ? toRepo(r) : null;
  }

  async findByIds(ids: string[]): Promise<Repository[]> {
    if (!ids.length) return [];
    return (await this.db.selectFrom('repositories').selectAll().where('id', 'in', ids).execute()).map(toRepo);
  }

  async list(filter: RepositoryListFilter): Promise<Page<Repository>> {
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return { items: [], total: 0 };
    let q = this.db.selectFrom('repositories');
    if (filter.search) {
      const p = likePattern(filter.search);
      q = q.where((eb) => eb.or([eb('fullName', 'ilike', p), eb('description', 'ilike', p)]));
    }
    if (filter.sourceId) q = q.where('sourceId', '=', filter.sourceId);
    if (filter.teamId) q = q.where('teamId', '=', filter.teamId);
    if (filter.active !== undefined) q = q.where('active', '=', filter.active);
    if (filter.visibleTeamIds) q = q.where('teamId', 'in', filter.visibleTeamIds);
    if (!filter.includeRemoved) q = q.where('removedAt', 'is', null);
    const [{ total }, rows] = await Promise.all([
      q.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow(),
      q.selectAll().orderBy('active', 'desc').orderBy('fullName').offset(filter.offset).limit(filter.limit).execute(),
    ]);
    return { items: rows.map(toRepo), total };
  }

  async update(id: string, patch: RepositoryPatch): Promise<Repository | null> {
    const { schedule, notifyEmails, disabledScanners, ...rest } = patch;
    await this.db
      .updateTable('repositories')
      .set({
        ...rest,
        ...(schedule !== undefined ? { schedule: JSON.stringify(schedule) } : {}),
        ...(notifyEmails !== undefined ? { notifyEmails: JSON.stringify(notifyEmails) } : {}),
        ...(disabledScanners !== undefined ? { disabledScanners: JSON.stringify(disabledScanners) } : {}),
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async findDue(now: Date, limit: number): Promise<Repository[]> {
    const rows = await this.db
      .selectFrom('repositories')
      .selectAll()
      .where('active', '=', true)
      .where('removedAt', 'is', null)
      .where('nextScanAt', '<=', now)
      .orderBy('nextScanAt')
      .limit(limit)
      .execute();
    return rows.map(toRepo);
  }
}

export class PgScanRunRepo implements ScanRunRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewScanRun): Promise<ScanRun> {
    const run: ScanRun = {
      ...input,
      id: randomUUID(),
      status: 'queued',
      commitSha: null,
      attempts: 0,
      queuedAt: new Date(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null,
      stats: null,
      log: [],
    };
    await this.db
      .insertInto('scanRuns')
      .values({ ...run, stats: null, log: '[]' })
      .execute();
    return run;
  }

  async findById(id: string): Promise<ScanRun | null> {
    const r = await this.db.selectFrom('scanRuns').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRun(r) : null;
  }

  async update(id: string, patch: ScanRunPatch): Promise<ScanRun | null> {
    const { stats, log, ...rest } = patch;
    await this.db
      .updateTable('scanRuns')
      .set({
        ...rest,
        ...(stats !== undefined ? { stats: stats ? JSON.stringify(stats) : null } : {}),
        ...(log !== undefined ? { log: JSON.stringify(log) } : {}),
      })
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.deleteFrom('scanRuns').where('id', '=', id).executeTakeFirst()).numDeletedRows > 0n;
  }

  async findActiveForRepo(repoId: string): Promise<ScanRun | null> {
    const r = await this.db.selectFrom('scanRuns').selectAll().where('repoId', '=', repoId).where('status', 'in', ['queued', 'running']).orderBy('queuedAt', 'desc').executeTakeFirst();
    return r ? toRun(r) : null;
  }

  async list(filter: ScanRunListFilter): Promise<Page<ScanRun>> {
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return { items: [], total: 0 };
    let q = this.db.selectFrom('scanRuns');
    if (filter.repoId) q = q.where('repoId', '=', filter.repoId);
    if (filter.status) q = q.where('status', '=', filter.status);
    if (filter.visibleTeamIds) q = q.where('teamId', 'in', filter.visibleTeamIds);
    const [{ total }, rows] = await Promise.all([
      q.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow(),
      // The log can be large; list views do not need it.
      q
        .select([
          'id',
          'repoId',
          'sourceId',
          'teamId',
          'trigger',
          'status',
          'requestedBy',
          'branch',
          'commitSha',
          'attempts',
          'queuedAt',
          'startedAt',
          'finishedAt',
          'durationMs',
          'error',
          'stats',
        ])
        .orderBy('queuedAt', 'desc')
        .offset(filter.offset)
        .limit(filter.limit)
        .execute(),
    ]);
    return { items: rows.map((r) => toRun({ ...r, log: [] as never })), total };
  }

  async setTeamForRepo(repoId: string, teamId: string | null): Promise<void> {
    await this.db.updateTable('scanRuns').set({ teamId }).where('repoId', '=', repoId).execute();
  }

  async deleteFinishedBefore(before: Date): Promise<number> {
    const res = await this.db.deleteFrom('scanRuns').where('finishedAt', '<', before).where('status', 'in', ['succeeded', 'failed', 'cancelled']).executeTakeFirst();
    return Number(res.numDeletedRows);
  }
}

export class PgJobRepo implements JobRepo {
  constructor(private readonly db: Db) {}

  async enqueue(input: NewJob): Promise<Job | null> {
    const now = new Date();
    const row = await this.db
      .insertInto('jobs')
      .values({
        id: randomUUID(),
        type: input.type,
        payload: JSON.stringify(input.payload),
        status: 'queued',
        priority: input.priority ?? 0,
        runAt: input.runAt ?? now,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        lockedBy: null,
        lockedUntil: null,
        lastError: null,
        dedupeKey: input.dedupeKey ?? null,
        activeDedupeKey: input.dedupeKey ?? null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      })
      .onConflict((oc) => oc.column('activeDedupeKey').doNothing())
      .returningAll()
      .executeTakeFirst();
    return row ? toJob(row) : null;
  }

  async claim(types: string[], workerId: string, leaseMs: number): Promise<Job | null> {
    if (!types.length) return null;
    const now = new Date();
    const row = await this.db
      .updateTable('jobs')
      .set((eb) => ({ status: 'running', lockedBy: workerId, lockedUntil: new Date(now.getTime() + leaseMs), attempts: eb('attempts', '+', 1), updatedAt: now }))
      .where('id', '=', (eb) =>
        eb
          .selectFrom('jobs as j')
          .select('j.id')
          .where('j.type', 'in', types)
          .where((w) => w.or([w.and([w('j.status', '=', 'queued'), w('j.runAt', '<=', now)]), w.and([w('j.status', '=', 'running'), w('j.lockedUntil', '<', now)])]))
          .orderBy('j.priority', 'desc')
          .orderBy('j.runAt')
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ? toJob(row) : null;
  }

  async extendLease(id: string, workerId: string, leaseMs: number): Promise<boolean> {
    const res = await this.db
      .updateTable('jobs')
      .set({ lockedUntil: new Date(Date.now() + leaseMs), updatedAt: new Date() })
      .where('id', '=', id)
      .where('lockedBy', '=', workerId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    return res.numUpdatedRows > 0n;
  }

  async complete(id: string, workerId: string): Promise<boolean> {
    const now = new Date();
    const res = await this.db
      .updateTable('jobs')
      .set({ status: 'succeeded', finishedAt: now, updatedAt: now, lockedBy: null, lockedUntil: null, activeDedupeKey: null })
      .where('id', '=', id)
      .where('lockedBy', '=', workerId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    return res.numUpdatedRows > 0n;
  }

  async fail(id: string, workerId: string, error: string, retryAt: Date | null): Promise<boolean> {
    const now = new Date();
    const res = await this.db
      .updateTable('jobs')
      .set(
        retryAt
          ? { status: 'queued', runAt: retryAt, lockedBy: null, lockedUntil: null, lastError: error, updatedAt: now }
          : { status: 'failed', finishedAt: now, lockedBy: null, lockedUntil: null, lastError: error, updatedAt: now, activeDedupeKey: null },
      )
      .where('id', '=', id)
      .where('lockedBy', '=', workerId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    return res.numUpdatedRows > 0n;
  }

  async findById(id: string): Promise<Job | null> {
    const r = await this.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toJob(r) : null;
  }

  async deleteFinishedBefore(before: Date): Promise<number> {
    const res = await this.db.deleteFrom('jobs').where('finishedAt', '<', before).where('status', 'not in', ACTIVE_JOB_STATUSES).executeTakeFirst();
    return Number(res.numDeletedRows);
  }
}

export class PgLockRepo implements LockRepo {
  constructor(private readonly db: Db) {}

  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const row = await this.db
      .insertInto('locks')
      .values({ name, owner, expiresAt })
      .onConflict((oc) =>
        oc
          .column('name')
          .doUpdateSet({ owner, expiresAt })
          .where((eb) => eb.or([eb('locks.expiresAt', '<', now), eb('locks.owner', '=', owner)])),
      )
      .returning('name')
      .executeTakeFirst();
    return !!row;
  }

  async release(name: string, owner: string): Promise<void> {
    await this.db.deleteFrom('locks').where('name', '=', name).where('owner', '=', owner).execute();
  }
}
