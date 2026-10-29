import { randomUUID } from 'node:crypto';
import { type AnyBulkWriteOperation, type Collection, type Db, type Filter, MongoServerError } from 'mongodb';
import { type Page } from '../models';
import {
  type DiscoveredRepo,
  type DiscoveryDefaults,
  type Job,
  type NewJob,
  type NewScanRun,
  type NewSource,
  type Repository,
  type RepositoryListFilter,
  type RepositoryPatch,
  type ScanRun,
  type ScanRunListFilter,
  type ScanRunPatch,
  type Source,
  type SourcePatch,
  type SourceWithCounts,
  type SyncResult,
} from '../scanning-models';
import { type JobRepo, type LockRepo, type RepositoryRepo, type ScanRunRepo, type SourceRepo } from '../store';

export type SourceDoc = Omit<Source, 'id'> & { _id: string };
export type RepositoryDoc = Omit<Repository, 'id'> & { _id: string };
export type ScanRunDoc = Omit<ScanRun, 'id'> & { _id: string };
export type JobDoc = Omit<Job, 'id'> & { _id: string; activeDedupeKey?: string };
export type LockDoc = { _id: string; owner: string; expiresAt: Date };

function strip<T extends { _id: string }>(doc: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

/** Repository documents written before a field existed get its default. */
function toRepository(doc: RepositoryDoc): Repository {
  return { ...strip(doc), disabledScanners: doc.disabledScanners ?? [] };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const METADATA_KEYS = ['fullName', 'name', 'htmlUrl', 'cloneUrl', 'defaultBranch', 'visibility', 'language', 'description', 'archived', 'lastPushedAt'] as const;

function metadataChanged(existing: RepositoryDoc, d: DiscoveredRepo): boolean {
  if (existing.removedAt) return true;
  return METADATA_KEYS.some((k) => {
    const a = existing[k];
    const b = d[k];
    return a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime() : a !== b;
  });
}

export class MongoSourceRepo implements SourceRepo {
  constructor(
    private readonly col: Collection<SourceDoc>,
    private readonly repos: Collection<RepositoryDoc>,
    private readonly runs: Collection<ScanRunDoc>,
    private readonly db: Db,
  ) {}

  async create(input: NewSource): Promise<Source> {
    const now = new Date();
    const source: Source = { ...input, id: randomUUID(), status: 'pending', lastSyncAt: null, lastSyncError: null, createdAt: now, updatedAt: now };
    const { id, ...rest } = source;
    await this.col.insertOne({ _id: id, ...rest });
    return source;
  }

  async findById(id: string): Promise<Source | null> {
    const doc = await this.col.findOne({ _id: id });
    return doc ? strip(doc) : null;
  }

  async list(): Promise<SourceWithCounts[]> {
    const docs = await this.col.find().sort({ name: 1 }).toArray();
    const counts = await this.repos
      .aggregate<{ _id: string; total: number; active: number }>([
        { $match: { removedAt: null } },
        { $group: { _id: '$sourceId', total: { $sum: 1 }, active: { $sum: { $cond: ['$active', 1, 0] } } } },
      ])
      .toArray();
    const by = new Map(counts.map((c) => [c._id, c]));
    return docs.map((d) => ({ ...strip(d), repoCount: by.get(d._id)?.total ?? 0, activeRepoCount: by.get(d._id)?.active ?? 0 }));
  }

  async update(id: string, patch: SourcePatch): Promise<Source | null> {
    const doc = await this.col.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
    return doc ? strip(doc) : null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.col.deleteOne({ _id: id });
    if (res.deletedCount === 0) return false;
    const repoIds = (await this.repos.find({ sourceId: id }, { projection: { _id: 1 } }).toArray()).map((r) => r._id);
    await this.runs.deleteMany({ sourceId: id });
    // Mirrors the ON DELETE CASCADE foreign keys of the PostgreSQL schema.
    for (const name of ['findings', 'dependencies', 'suppressions']) await this.db.collection(name).deleteMany({ repoId: { $in: repoIds } });
    await this.repos.deleteMany({ sourceId: id });
    return true;
  }
}

export class MongoRepositoryRepo implements RepositoryRepo {
  constructor(private readonly col: Collection<RepositoryDoc>) {}

  async syncFromSource(sourceId: string, discovered: DiscoveredRepo[], defaults: DiscoveryDefaults): Promise<SyncResult> {
    const existing = new Map((await this.col.find({ sourceId }).toArray()).map((d) => [d.externalId, d]));
    const now = new Date();
    const result: SyncResult = { added: 0, updated: 0, removed: 0, activated: [] };
    const ops: AnyBulkWriteOperation<RepositoryDoc>[] = [];
    const seen = new Set<string>();

    for (const d of discovered) {
      if (seen.has(d.externalId)) continue;
      seen.add(d.externalId);
      const current = existing.get(d.externalId);
      if (current) {
        if (metadataChanged(current, d)) {
          ops.push({ updateOne: { filter: { _id: current._id }, update: { $set: { ...Object.fromEntries(METADATA_KEYS.map((k) => [k, d[k]])), removedAt: null, updatedAt: now } } } });
          result.updated++;
        }
        continue;
      }
      const id = randomUUID();
      const active = !d.archived && defaults.activate(d);
      if (active) result.activated.push(id);
      ops.push({
        insertOne: {
          document: {
            ...d,
            _id: id,
            sourceId,
            removedAt: null,
            active,
            teamId: defaults.teamId,
            criticality: 'medium',
            branch: null,
            schedule: defaults.schedule,
            scanOnPush: true,
            jiraProjectKey: null,
            notifyEmails: [],
            disabledScanners: [],
            nextScanAt: active ? defaults.firstScanAt : null,
            lastScanAt: null,
            lastScanStatus: null,
            lastScanRunId: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      });
      result.added++;
    }
    const missing = [...existing.values()].filter((r) => !seen.has(r.externalId) && !r.removedAt).map((r) => r._id);
    if (missing.length) {
      ops.push({ updateMany: { filter: { _id: { $in: missing } }, update: { $set: { removedAt: now, active: false, nextScanAt: null, updatedAt: now } } } });
    }
    result.removed = missing.length;
    if (ops.length) await this.col.bulkWrite(ops, { ordered: false });
    return result;
  }

  async findById(id: string): Promise<Repository | null> {
    const doc = await this.col.findOne({ _id: id });
    return doc ? toRepository(doc) : null;
  }

  async findByExternalId(sourceId: string, externalId: string): Promise<Repository | null> {
    const doc = await this.col.findOne({ sourceId, externalId });
    return doc ? toRepository(doc) : null;
  }

  async findByIds(ids: string[]): Promise<Repository[]> {
    if (!ids.length) return [];
    return (await this.col.find({ _id: { $in: ids } }).toArray()).map(toRepository);
  }

  async list(filter: RepositoryListFilter): Promise<Page<Repository>> {
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return { items: [], total: 0 };
    const q: Filter<RepositoryDoc> = {};
    if (filter.search) {
      const re = new RegExp(escapeRegex(filter.search), 'i');
      q.$or = [{ fullName: re }, { description: re }];
    }
    if (filter.sourceId) q.sourceId = filter.sourceId;
    if (filter.teamId) q.teamId = filter.teamId;
    if (filter.active !== undefined) q.active = filter.active;
    if (filter.visibleTeamIds) q.teamId = filter.teamId ? (filter.visibleTeamIds.includes(filter.teamId) ? filter.teamId : '__none__') : { $in: filter.visibleTeamIds };
    if (!filter.includeRemoved) q.removedAt = null;
    const [total, docs] = await Promise.all([
      this.col.countDocuments(q),
      this.col.find(q).sort({ active: -1, fullName: 1 }).skip(filter.offset).limit(filter.limit).toArray(),
    ]);
    return { items: docs.map(toRepository), total };
  }

  async update(id: string, patch: RepositoryPatch): Promise<Repository | null> {
    const doc = await this.col.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
    return doc ? toRepository(doc) : null;
  }

  async findDue(now: Date, limit: number): Promise<Repository[]> {
    return (await this.col.find({ active: true, removedAt: null, nextScanAt: { $lte: now } }).sort({ nextScanAt: 1 }).limit(limit).toArray()).map(toRepository);
  }
}

export class MongoScanRunRepo implements ScanRunRepo {
  constructor(private readonly col: Collection<ScanRunDoc>) {}

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
    const { id, ...rest } = run;
    await this.col.insertOne({ _id: id, ...rest });
    return run;
  }

  async findById(id: string): Promise<ScanRun | null> {
    const doc = await this.col.findOne({ _id: id });
    return doc ? strip(doc) : null;
  }

  async update(id: string, patch: ScanRunPatch): Promise<ScanRun | null> {
    const doc = await this.col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: 'after' });
    return doc ? strip(doc) : null;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount > 0;
  }

  async findActiveForRepo(repoId: string): Promise<ScanRun | null> {
    const doc = await this.col.findOne({ repoId, status: { $in: ['queued', 'running'] } }, { sort: { queuedAt: -1 } });
    return doc ? strip(doc) : null;
  }

  async list(filter: ScanRunListFilter): Promise<Page<ScanRun>> {
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return { items: [], total: 0 };
    const q: Filter<ScanRunDoc> = {};
    if (filter.repoId) q.repoId = filter.repoId;
    if (filter.status) q.status = filter.status;
    if (filter.visibleTeamIds) q.teamId = { $in: filter.visibleTeamIds };
    const [total, docs] = await Promise.all([
      this.col.countDocuments(q),
      this.col.find(q, { projection: { log: 0 } }).sort({ queuedAt: -1 }).skip(filter.offset).limit(filter.limit).toArray(),
    ]);
    return { items: docs.map((d) => ({ ...strip(d), log: [] })), total };
  }

  async deleteFinishedBefore(before: Date): Promise<number> {
    return (await this.col.deleteMany({ finishedAt: { $lt: before }, status: { $in: ['succeeded', 'failed', 'cancelled'] } })).deletedCount;
  }

  async setTeamForRepo(repoId: string, teamId: string | null): Promise<void> {
    await this.col.updateMany({ repoId }, { $set: { teamId } });
  }
}

function toJob(doc: JobDoc): Job {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { activeDedupeKey, ...rest } = doc;
  return strip(rest);
}

export class MongoJobRepo implements JobRepo {
  constructor(private readonly col: Collection<JobDoc>) {}

  async enqueue(input: NewJob): Promise<Job | null> {
    const now = new Date();
    const doc: JobDoc = {
      _id: randomUUID(),
      type: input.type,
      payload: input.payload,
      status: 'queued',
      priority: input.priority ?? 0,
      runAt: input.runAt ?? now,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      dedupeKey: input.dedupeKey ?? null,
      ...(input.dedupeKey ? { activeDedupeKey: input.dedupeKey } : {}),
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    try {
      await this.col.insertOne(doc);
      return toJob(doc);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) return null;
      throw err;
    }
  }

  async claim(types: string[], workerId: string, leaseMs: number): Promise<Job | null> {
    if (!types.length) return null;
    const now = new Date();
    const doc = await this.col.findOneAndUpdate(
      {
        type: { $in: types },
        $or: [
          { status: 'queued', runAt: { $lte: now } },
          { status: 'running', lockedUntil: { $lt: now } },
        ],
      },
      { $set: { status: 'running', lockedBy: workerId, lockedUntil: new Date(now.getTime() + leaseMs), updatedAt: now }, $inc: { attempts: 1 } },
      { sort: { priority: -1, runAt: 1 }, returnDocument: 'after' },
    );
    return doc ? toJob(doc) : null;
  }

  async extendLease(id: string, workerId: string, leaseMs: number): Promise<boolean> {
    const res = await this.col.updateOne({ _id: id, lockedBy: workerId, status: 'running' }, { $set: { lockedUntil: new Date(Date.now() + leaseMs), updatedAt: new Date() } });
    return res.modifiedCount > 0;
  }

  async complete(id: string, workerId: string): Promise<boolean> {
    const now = new Date();
    const res = await this.col.updateOne(
      { _id: id, lockedBy: workerId, status: 'running' },
      { $set: { status: 'succeeded', finishedAt: now, updatedAt: now, lockedBy: null, lockedUntil: null }, $unset: { activeDedupeKey: '' } },
    );
    return res.modifiedCount > 0;
  }

  async fail(id: string, workerId: string, error: string, retryAt: Date | null): Promise<boolean> {
    const now = new Date();
    const res = await this.col.updateOne(
      { _id: id, lockedBy: workerId, status: 'running' },
      retryAt
        ? { $set: { status: 'queued', runAt: retryAt, lockedBy: null, lockedUntil: null, lastError: error, updatedAt: now } }
        : { $set: { status: 'failed', finishedAt: now, lockedBy: null, lockedUntil: null, lastError: error, updatedAt: now }, $unset: { activeDedupeKey: '' } },
    );
    return res.modifiedCount > 0;
  }

  async findById(id: string): Promise<Job | null> {
    const doc = await this.col.findOne({ _id: id });
    return doc ? toJob(doc) : null;
  }

  async deleteFinishedBefore(before: Date): Promise<number> {
    return (await this.col.deleteMany({ finishedAt: { $lt: before }, status: { $nin: ['queued', 'running'] } })).deletedCount;
  }
}

export class MongoLockRepo implements LockRepo {
  constructor(private readonly col: Collection<LockDoc>) {}

  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    try {
      // Matches only a free (expired) or self-held lease; otherwise the upsert collides on _id.
      const doc = await this.col.findOneAndUpdate(
        { _id: name, $or: [{ expiresAt: { $lt: now } }, { owner }] },
        { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
        { upsert: true, returnDocument: 'after' },
      );
      return !!doc;
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) return false;
      throw err;
    }
  }

  async release(name: string, owner: string): Promise<void> {
    await this.col.deleteOne({ _id: name, owner });
  }
}

export async function bootstrapScanningIndexes(db: Db): Promise<void> {
  await db.collection('sources').createIndexes([{ key: { name: 1 }, name: 'name' }]);
  await db.collection('repositories').createIndexes([
    { key: { sourceId: 1, externalId: 1 }, unique: true, name: 'source_external_unique' },
    { key: { active: 1, removedAt: 1, nextScanAt: 1 }, name: 'due' },
    { key: { teamId: 1 }, name: 'team' },
    { key: { fullName: 1 }, name: 'full_name' },
  ]);
  await db.collection('scan_runs').createIndexes([
    { key: { repoId: 1, queuedAt: -1 }, name: 'repo_queued' },
    { key: { queuedAt: -1 }, name: 'queued' },
    { key: { status: 1 }, name: 'status' },
    { key: { teamId: 1 }, name: 'team' },
  ]);
  await db.collection('jobs').createIndexes([
    { key: { status: 1, type: 1, runAt: 1 }, name: 'runnable' },
    { key: { activeDedupeKey: 1 }, unique: true, name: 'active_dedupe_unique', partialFilterExpression: { activeDedupeKey: { $type: 'string' } } },
    { key: { finishedAt: 1 }, name: 'finished' },
  ]);
}
