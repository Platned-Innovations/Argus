import { randomUUID } from 'node:crypto';
import { type AnyBulkWriteOperation, type Collection, type Db, type Filter } from 'mongodb';
import { type ScannerName, SCANNERS, type Severity, SEVERITIES } from '@argus/shared';
import {
  type CacheEntry,
  type Dependency,
  type DependencyListFilter,
  type DependencySearchFilter,
  type Finding,
  type FindingListFilter,
  type FindingSummaryRecord,
  type NewSuppression,
  type ObservedFinding,
  type ReconcileContext,
  type ReconcileResult,
  type Suppression,
} from '../findings-models';
import { type Page } from '../models';
import { type CacheRepo, type DependencyRepo, type FindingRepo, type SuppressionRepo } from '../store';

export type FindingDoc = Omit<Finding, 'id'> & { _id: string };
export type DependencyDoc = Dependency & { _id: string; nameLower: string };
export type SuppressionDoc = Omit<Suppression, 'id'> & { _id: string };
export type CacheDoc = { _id: string; value: unknown; fetchedAt: Date; expiresAt: Date };

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toFinding({ _id, ...rest }: FindingDoc): Finding {
  return { id: _id, ...rest };
}

function observedFields(o: ObservedFinding) {
  return { ...o, status: o.suppressionId ? ('suppressed' as const) : ('open' as const) };
}

export class MongoFindingRepo implements FindingRepo {
  constructor(private readonly col: Collection<FindingDoc>) {}

  async reconcile(ctx: ReconcileContext, observed: ObservedFinding[]): Promise<ReconcileResult> {
    const existing = new Map(
      (await this.col.find({ repoId: ctx.repoId }, { projection: { fingerprint: 1, status: 1, scanner: 1 } }).toArray()).map((d) => [d.fingerprint, d]),
    );
    const result: ReconcileResult = { opened: 0, reopened: 0, fixed: 0, unchanged: 0 };
    const seen = new Set<string>();
    const ops: AnyBulkWriteOperation<FindingDoc>[] = [];

    for (const o of observed) {
      if (seen.has(o.fingerprint)) continue;
      seen.add(o.fingerprint);
      const current = existing.get(o.fingerprint);
      if (current) {
        if (current.status === 'fixed') result.reopened++;
        else result.unchanged++;
        ops.push({ updateOne: { filter: { _id: current._id }, update: { $set: { ...observedFields(o), teamId: ctx.teamId, lastSeenAt: ctx.now, lastRunId: ctx.runId, fixedAt: null } } } });
      } else {
        result.opened++;
        ops.push({
          insertOne: {
            document: {
              ...observedFields(o),
              _id: randomUUID(),
              repoId: ctx.repoId,
              sourceId: ctx.sourceId,
              teamId: ctx.teamId,
              firstSeenAt: ctx.now,
              lastSeenAt: ctx.now,
              firstRunId: ctx.runId,
              lastRunId: ctx.runId,
              fixedAt: null,
            },
          },
        });
      }
    }
    const scanners = new Set<string>(ctx.scanners);
    const gone = [...existing.values()].filter((f) => !seen.has(f.fingerprint) && f.status !== 'fixed' && scanners.has(f.scanner)).map((f) => f._id);
    if (gone.length) ops.push({ updateMany: { filter: { _id: { $in: gone } }, update: { $set: { status: 'fixed', fixedAt: ctx.now, lastRunId: ctx.runId } } } });
    result.fixed = gone.length;
    if (ops.length) await this.col.bulkWrite(ops, { ordered: false });
    return result;
  }

  async findById(id: string): Promise<Finding | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? toFinding(d) : null;
  }

  async list(filter: FindingListFilter): Promise<Page<Finding>> {
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return { items: [], total: 0 };
    const q: Filter<FindingDoc> = {};
    if (filter.repoId) q.repoId = filter.repoId;
    if (filter.scanner) q.scanner = filter.scanner;
    if (filter.severities?.length) q.severity = { $in: filter.severities };
    if (filter.status) q.status = filter.status;
    if (filter.visibleTeamIds) q.teamId = { $in: filter.visibleTeamIds };
    if (filter.search) {
      const re = new RegExp(escapeRegex(filter.search), 'i');
      q.$or = [{ title: re }, { ruleId: re }, { path: re }, { 'package.name': re }];
    }
    const [total, docs] = await Promise.all([
      this.col.countDocuments(q),
      this.col.find(q).sort({ riskScore: -1, lastSeenAt: -1, _id: 1 }).skip(filter.offset).limit(filter.limit).toArray(),
    ]);
    return { items: docs.map(toFinding), total };
  }

  async update(id: string, patch: Partial<Pick<Finding, 'status' | 'suppressionId'>>): Promise<Finding | null> {
    const d = await this.col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: 'after' });
    return d ? toFinding(d) : null;
  }

  async summary(filter: { repoId?: string; visibleTeamIds?: string[]; fixedSince: Date }): Promise<FindingSummaryRecord> {
    const out: FindingSummaryRecord = {
      open: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>,
      suppressed: 0,
      fixedSince: 0,
      byScanner: Object.fromEntries(SCANNERS.map((s) => [s, 0])) as Record<ScannerName, number>,
    };
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return out;
    const match: Filter<FindingDoc> = {};
    if (filter.repoId) match.repoId = filter.repoId;
    if (filter.visibleTeamIds) match.teamId = { $in: filter.visibleTeamIds };
    const rows = await this.col
      .aggregate<{ _id: { status: string; severity: Severity; scanner: ScannerName }; n: number; recentlyFixed: number }>([
        { $match: match },
        {
          $group: {
            _id: { status: '$status', severity: '$severity', scanner: '$scanner' },
            n: { $sum: 1 },
            recentlyFixed: { $sum: { $cond: [{ $gte: ['$fixedAt', filter.fixedSince] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    for (const r of rows) {
      if (r._id.status === 'open') {
        out.open[r._id.severity] += r.n;
        out.byScanner[r._id.scanner] += r.n;
      } else if (r._id.status === 'suppressed') out.suppressed += r.n;
      else out.fixedSince += r.recentlyFixed;
    }
    return out;
  }

  async setTeamForRepo(repoId: string, teamId: string | null): Promise<void> {
    await this.col.updateMany({ repoId }, { $set: { teamId } });
  }
}

export class MongoDependencyRepo implements DependencyRepo {
  constructor(private readonly col: Collection<DependencyDoc>) {}

  async replaceForRepo(repoId: string, deps: Dependency[]): Promise<void> {
    await this.col.deleteMany({ repoId });
    if (deps.length) await this.col.insertMany(deps.map((d) => ({ ...d, repoId, _id: randomUUID(), nameLower: d.name.toLowerCase() })), { ordered: false });
  }

  private strip({ _id, nameLower, ...rest }: DependencyDoc): Dependency {
    void _id;
    void nameLower;
    return rest;
  }

  async listForRepo(repoId: string, filter: DependencyListFilter): Promise<Page<Dependency>> {
    const q: Filter<DependencyDoc> = { repoId };
    if (filter.search) q.nameLower = { $regex: escapeRegex(filter.search.toLowerCase()) };
    if (filter.ecosystem) q.ecosystem = filter.ecosystem;
    if (filter.vulnerableOnly) q.vulnerabilities = { $gt: 0 };
    const [total, docs] = await Promise.all([
      this.col.countDocuments(q),
      this.col.find(q).sort({ vulnerabilities: -1, direct: -1, nameLower: 1, version: 1 }).skip(filter.offset).limit(filter.limit).toArray(),
    ]);
    return { items: docs.map((d) => this.strip(d)), total };
  }

  async search(filter: DependencySearchFilter): Promise<Dependency[]> {
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return [];
    const q: Filter<DependencyDoc> = { nameLower: filter.name.toLowerCase() };
    if (filter.ecosystem) q.ecosystem = filter.ecosystem;
    if (filter.visibleTeamIds) q.teamId = { $in: filter.visibleTeamIds };
    return (await this.col.find(q).sort({ repoId: 1, version: 1 }).limit(filter.limit).toArray()).map((d) => this.strip(d));
  }

  async setTeamForRepo(repoId: string, teamId: string | null): Promise<void> {
    await this.col.updateMany({ repoId }, { $set: { teamId } });
  }
}

export class MongoSuppressionRepo implements SuppressionRepo {
  constructor(private readonly col: Collection<SuppressionDoc>) {}

  async create(input: NewSuppression): Promise<Suppression> {
    const s: Suppression = { ...input, id: randomUUID(), createdAt: new Date() };
    const { id, ...rest } = s;
    await this.col.insertOne({ _id: id, ...rest });
    return s;
  }

  async findById(id: string): Promise<Suppression | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? { id: d._id, ...stripId(d) } : null;
  }

  async list(filter: { repoId?: string } = {}): Promise<Suppression[]> {
    const q: Filter<SuppressionDoc> = filter.repoId ? { $or: [{ repoId: filter.repoId }, { repoId: null }] } : {};
    return (await this.col.find(q).sort({ createdAt: -1 }).toArray()).map((d) => ({ id: d._id, ...stripId(d) }));
  }

  async listApplicable(repoId: string, now: Date): Promise<Suppression[]> {
    const docs = await this.col
      .find({ $and: [{ $or: [{ repoId }, { repoId: null }] }, { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }] })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map((d) => ({ id: d._id, ...stripId(d) }));
  }

  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount > 0;
  }
}

function stripId<T extends { _id: string }>(d: T): Omit<T, '_id'> {
  const { _id, ...rest } = d;
  void _id;
  return rest;
}

export class MongoCacheRepo implements CacheRepo {
  constructor(private readonly col: Collection<CacheDoc>) {}

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const d = await this.col.findOne({ _id: key });
    return d ? { key, value: d.value as T, fetchedAt: d.fetchedAt, expiresAt: d.expiresAt } : null;
  }

  async getMany<T>(keys: string[]): Promise<Map<string, CacheEntry<T>>> {
    const out = new Map<string, CacheEntry<T>>();
    if (!keys.length) return out;
    for (const d of await this.col.find({ _id: { $in: keys } }).toArray()) out.set(d._id, { key: d._id, value: d.value as T, fetchedAt: d.fetchedAt, expiresAt: d.expiresAt });
    return out;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const fetchedAt = new Date();
    await this.col.updateOne({ _id: key }, { $set: { value, fetchedAt, expiresAt: new Date(fetchedAt.getTime() + ttlMs) } }, { upsert: true });
  }

  async deleteExpired(before: Date): Promise<number> {
    return (await this.col.deleteMany({ expiresAt: { $lt: before } })).deletedCount;
  }
}

export async function bootstrapFindingIndexes(db: Db): Promise<void> {
  await db.collection('findings').createIndexes([
    { key: { repoId: 1, fingerprint: 1 }, unique: true, name: 'repo_fingerprint_unique' },
    { key: { status: 1, riskScore: -1 }, name: 'status_score' },
    { key: { teamId: 1, status: 1 }, name: 'team_status' },
    { key: { 'package.ecosystem': 1, 'package.name': 1 }, name: 'package' },
  ]);
  await db.collection('dependencies').createIndexes([
    { key: { repoId: 1 }, name: 'repo' },
    { key: { nameLower: 1, ecosystem: 1 }, name: 'name' },
  ]);
  await db.collection('suppressions').createIndexes([{ key: { repoId: 1 }, name: 'repo' }]);
  await db.collection('intel_cache').createIndexes([{ key: { expiresAt: 1 }, name: 'expires' }]);
}
