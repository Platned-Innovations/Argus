import { randomUUID } from 'node:crypto';
import { type FindingStatRow, type StatsFilter } from '../platform-models';
import { type Kysely, type Selectable, sql } from 'kysely';
import { type FindingStatus, type ScannerName, SCANNERS, type Severity, SEVERITIES } from '@argus/shared';
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
import { type Database, type DependenciesTable, type FindingsTable, type SuppressionsTable } from './schema';

/** Upper bound on rows for dashboard statistics. */
const STATS_LIMIT = 200_000;

type Db = Kysely<Database>;
const CHUNK = 500;

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function toFinding(r: Selectable<FindingsTable>): Finding {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { packageEcosystem, packageName, ...rest } = r;
  return {
    ...rest,
    scanner: r.scanner as ScannerName,
    severity: r.severity as Severity,
    status: r.status as FindingStatus,
    riskFactors: (r.riskFactors ?? []) as Finding['riskFactors'],
    package: (r.package ?? null) as Finding['package'],
    advisory: (r.advisory ?? null) as Finding['advisory'],
    secret: (r.secret ?? null) as Finding['secret'],
    details: r.details ?? null,
  };
}

/** Columns written from an observed finding (shared by insert and refresh). */
function observedColumns(o: ObservedFinding) {
  return {
    scanner: o.scanner,
    ruleId: o.ruleId,
    title: o.title,
    description: o.description,
    severity: o.severity,
    riskScore: o.riskScore,
    riskFactors: JSON.stringify(o.riskFactors),
    path: o.path,
    line: o.line,
    packageEcosystem: o.package?.ecosystem ?? null,
    packageName: o.package?.name ?? null,
    package: json(o.package),
    advisory: json(o.advisory),
    secret: json(o.secret),
    details: json(o.details),
    remediation: o.remediation,
    suppressionId: o.suppressionId,
    status: o.suppressionId ? 'suppressed' : 'open',
  };
}

export class PgFindingRepo implements FindingRepo {
  constructor(private readonly db: Db) {}

  async reconcile(ctx: ReconcileContext, observed: ObservedFinding[]): Promise<ReconcileResult> {
    return this.db.transaction().execute(async (trx) => {
      const existing = new Map(
        (await trx.selectFrom('findings').select(['id', 'fingerprint', 'status', 'scanner']).where('repoId', '=', ctx.repoId).execute()).map((r) => [r.fingerprint, r]),
      );
      const result: ReconcileResult = { opened: 0, reopened: 0, fixed: 0, unchanged: 0 };
      const seen = new Set<string>();
      const inserts: Database['findings'][] = [];

      for (const o of observed) {
        if (seen.has(o.fingerprint)) continue;
        seen.add(o.fingerprint);
        const current = existing.get(o.fingerprint);
        if (current) {
          if (current.status === 'fixed') result.reopened++;
          else result.unchanged++;
          await trx
            .updateTable('findings')
            .set({ ...observedColumns(o), teamId: ctx.teamId, lastSeenAt: ctx.now, lastRunId: ctx.runId, fixedAt: null })
            .where('id', '=', current.id)
            .execute();
        } else {
          result.opened++;
          inserts.push({
            ...observedColumns(o),
            id: randomUUID(),
            repoId: ctx.repoId,
            sourceId: ctx.sourceId,
            teamId: ctx.teamId,
            fingerprint: o.fingerprint,
            firstSeenAt: ctx.now,
            lastSeenAt: ctx.now,
            firstRunId: ctx.runId,
            lastRunId: ctx.runId,
            fixedAt: null,
            ticketId: null,
          } as never);
        }
      }
      for (let i = 0; i < inserts.length; i += CHUNK) {
        await trx
          .insertInto('findings')
          .values(inserts.slice(i, i + CHUNK) as never)
          .execute();
      }

      const scanners = new Set<string>(ctx.scanners);
      const gone = [...existing.values()].filter((f) => !seen.has(f.fingerprint) && f.status !== 'fixed' && scanners.has(f.scanner)).map((f) => f.id);
      for (let i = 0; i < gone.length; i += CHUNK) {
        await trx
          .updateTable('findings')
          .set({ status: 'fixed', fixedAt: ctx.now, lastRunId: ctx.runId })
          .where('id', 'in', gone.slice(i, i + CHUNK))
          .execute();
      }
      result.fixed = gone.length;
      return result;
    });
  }

  async findById(id: string): Promise<Finding | null> {
    const r = await this.db.selectFrom('findings').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toFinding(r) : null;
  }

  async list(filter: FindingListFilter): Promise<Page<Finding>> {
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return { items: [], total: 0 };
    let q = this.db.selectFrom('findings');
    if (filter.repoId) q = q.where('repoId', '=', filter.repoId);
    if (filter.scanner) q = q.where('scanner', '=', filter.scanner);
    if (filter.severities?.length) q = q.where('severity', 'in', filter.severities);
    if (filter.status) q = q.where('status', '=', filter.status);
    if (filter.visibleTeamIds) q = q.where('teamId', 'in', filter.visibleTeamIds);
    if (filter.search) {
      const p = likePattern(filter.search);
      q = q.where((eb) => eb.or([eb('title', 'ilike', p), eb('ruleId', 'ilike', p), eb('path', 'ilike', p), eb('packageName', 'ilike', p)]));
    }
    const [{ total }, rows] = await Promise.all([
      q.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow(),
      q.selectAll().orderBy('riskScore', 'desc').orderBy('lastSeenAt', 'desc').orderBy('id').offset(filter.offset).limit(filter.limit).execute(),
    ]);
    return { items: rows.map(toFinding), total };
  }

  async update(id: string, patch: Partial<Pick<Finding, 'status' | 'suppressionId'>>): Promise<Finding | null> {
    await this.db.updateTable('findings').set(patch).where('id', '=', id).execute();
    return this.findById(id);
  }

  async summary(filter: { repoId?: string; visibleTeamIds?: string[]; fixedSince: Date }): Promise<FindingSummaryRecord> {
    const out: FindingSummaryRecord = {
      open: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>,
      suppressed: 0,
      fixedSince: 0,
      byScanner: Object.fromEntries(SCANNERS.map((s) => [s, 0])) as Record<ScannerName, number>,
    };
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return out;
    let q = this.db.selectFrom('findings');
    if (filter.repoId) q = q.where('repoId', '=', filter.repoId);
    if (filter.visibleTeamIds) q = q.where('teamId', 'in', filter.visibleTeamIds);
    const rows = await q
      .select(['status', 'severity', 'scanner', sql<number>`count(*)::int`.as('n'), sql<number>`count(*) filter (where fixed_at >= ${filter.fixedSince})::int`.as('recentlyFixed')])
      .groupBy(['status', 'severity', 'scanner'])
      .execute();
    for (const r of rows) {
      if (r.status === 'open') {
        out.open[r.severity as Severity] += r.n;
        out.byScanner[r.scanner as ScannerName] += r.n;
      } else if (r.status === 'suppressed') out.suppressed += r.n;
      else out.fixedSince += r.recentlyFixed;
    }
    return out;
  }

  async setTicket(ids: string[], ticketId: string): Promise<void> {
    for (let i = 0; i < ids.length; i += CHUNK) {
      await this.db
        .updateTable('findings')
        .set({ ticketId })
        .where('id', 'in', ids.slice(i, i + CHUNK))
        .execute();
    }
  }

  async statsRows(f: StatsFilter): Promise<FindingStatRow[]> {
    if (f.visibleTeamIds && f.visibleTeamIds.length === 0) return [];
    let q = this.db
      .selectFrom('findings')
      .select(['repoId', 'scanner', 'severity', 'riskScore', 'status', 'firstSeenAt', 'fixedAt', 'title', 'details'])
      .where((eb) => eb.or([eb('status', '!=', 'fixed'), eb('firstSeenAt', '>=', f.since), eb('fixedAt', '>=', f.since)]));
    if (f.visibleTeamIds) q = q.where('teamId', 'in', f.visibleTeamIds);
    if (f.teamId) q = q.where('teamId', '=', f.teamId);
    if (f.repoId) q = q.where('repoId', '=', f.repoId);
    return (await q.limit(STATS_LIMIT).execute()).map((r) => ({ ...r, scanner: r.scanner as ScannerName, severity: r.severity as Severity, status: r.status as FindingStatus, details: r.details ?? null }));
  }
  async deleteFixedBefore(before: Date): Promise<number> {
    return Number((await this.db.deleteFrom('findings').where('status', '=', 'fixed').where('fixedAt', '<', before).executeTakeFirst()).numDeletedRows);
  }


  async listAllForRepo(repoId: string): Promise<Finding[]> {
    return (await this.db.selectFrom('findings').selectAll().where('repoId', '=', repoId).execute()).map(toFinding);
  }

  async setTeamForRepo(repoId: string, teamId: string | null): Promise<void> {
    await this.db.updateTable('findings').set({ teamId }).where('repoId', '=', repoId).execute();
  }
}

function toDependency(r: Selectable<DependenciesTable>): Dependency {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, nameLower, ...rest } = r;
  return { ...rest, ecosystem: r.ecosystem as Dependency['ecosystem'] };
}

export class PgDependencyRepo implements DependencyRepo {
  constructor(private readonly db: Db) {}

  async replaceForRepo(repoId: string, deps: Dependency[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('dependencies').where('repoId', '=', repoId).execute();
      const rows = deps.map((d) => ({ ...d, repoId, id: randomUUID(), nameLower: d.name.toLowerCase() }));
      for (let i = 0; i < rows.length; i += CHUNK) await trx.insertInto('dependencies').values(rows.slice(i, i + CHUNK)).execute();
    });
  }

  async listForRepo(repoId: string, filter: DependencyListFilter): Promise<Page<Dependency>> {
    let q = this.db.selectFrom('dependencies').where('repoId', '=', repoId);
    if (filter.search) q = q.where('nameLower', 'like', likePattern(filter.search.toLowerCase()));
    if (filter.ecosystem) q = q.where('ecosystem', '=', filter.ecosystem);
    if (filter.vulnerableOnly) q = q.where('vulnerabilities', '>', 0);
    const [{ total }, rows] = await Promise.all([
      q.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow(),
      q.selectAll().orderBy('vulnerabilities', 'desc').orderBy('direct', 'desc').orderBy('nameLower').orderBy('version').offset(filter.offset).limit(filter.limit).execute(),
    ]);
    return { items: rows.map(toDependency), total };
  }

  async search(filter: DependencySearchFilter): Promise<Dependency[]> {
    if (filter.visibleTeamIds && filter.visibleTeamIds.length === 0) return [];
    let q = this.db.selectFrom('dependencies').selectAll().where('nameLower', '=', filter.name.toLowerCase());
    if (filter.ecosystem) q = q.where('ecosystem', '=', filter.ecosystem);
    if (filter.visibleTeamIds) q = q.where('teamId', 'in', filter.visibleTeamIds);
    return (await q.orderBy('repoId').orderBy('version').limit(filter.limit).execute()).map(toDependency);
  }

  async setTeamForRepo(repoId: string, teamId: string | null): Promise<void> {
    await this.db.updateTable('dependencies').set({ teamId }).where('repoId', '=', repoId).execute();
  }
}

function toSuppression(r: Selectable<SuppressionsTable>): Suppression {
  return { ...r, scanner: r.scanner as ScannerName | null };
}

export class PgSuppressionRepo implements SuppressionRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewSuppression): Promise<Suppression> {
    const s: Suppression = { ...input, id: randomUUID(), createdAt: new Date() };
    await this.db.insertInto('suppressions').values(s).execute();
    return s;
  }

  async findById(id: string): Promise<Suppression | null> {
    const r = await this.db.selectFrom('suppressions').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toSuppression(r) : null;
  }

  async list(filter: { repoId?: string } = {}): Promise<Suppression[]> {
    let q = this.db.selectFrom('suppressions').selectAll();
    if (filter.repoId) {
      const repoId = filter.repoId;
      q = q.where((eb) => eb.or([eb('repoId', '=', repoId), eb('repoId', 'is', null)]));
    }
    return (await q.orderBy('createdAt', 'desc').execute()).map(toSuppression);
  }

  async listApplicable(repoId: string, now: Date): Promise<Suppression[]> {
    const rows = await this.db
      .selectFrom('suppressions')
      .selectAll()
      .where((eb) => eb.or([eb('repoId', '=', repoId), eb('repoId', 'is', null)]))
      .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)]))
      .orderBy('createdAt')
      .execute();
    return rows.map(toSuppression);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.deleteFrom('suppressions').where('id', '=', id).executeTakeFirst()).numDeletedRows > 0n;
  }
}

export class PgCacheRepo implements CacheRepo {
  constructor(private readonly db: Db) {}

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const r = await this.db.selectFrom('intelCache').selectAll().where('key', '=', key).executeTakeFirst();
    return r ? { ...r, value: r.value as T } : null;
  }

  async getMany<T>(keys: string[]): Promise<Map<string, CacheEntry<T>>> {
    const out = new Map<string, CacheEntry<T>>();
    for (let i = 0; i < keys.length; i += CHUNK) {
      const rows = await this.db
        .selectFrom('intelCache')
        .selectAll()
        .where('key', 'in', keys.slice(i, i + CHUNK))
        .execute();
      for (const r of rows) out.set(r.key, { ...r, value: r.value as T });
    }
    return out;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const fetchedAt = new Date();
    const row = { key, value: JSON.stringify(value), fetchedAt, expiresAt: new Date(fetchedAt.getTime() + ttlMs) };
    await this.db
      .insertInto('intelCache')
      .values(row)
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: row.value, fetchedAt: row.fetchedAt, expiresAt: row.expiresAt }))
      .execute();
  }

  async deleteExpired(before: Date): Promise<number> {
    return Number((await this.db.deleteFrom('intelCache').where('expiresAt', '<', before).executeTakeFirst()).numDeletedRows);
  }
}
