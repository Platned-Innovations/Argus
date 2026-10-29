import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type DataStore, type Finding, type Suppression, type User } from '@argus/data';
import {
  type FindingDto,
  type FindingSummary,
  type ListFindingsQuery,
  type Paged,
  type PackageSearchQuery,
  type PackageUsageDto,
  type SuppressionDto,
  type SuppressionInput,
} from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
import { DATA_STORE } from '../core/tokens';
import { canSeeRepo, visibleTeams } from '../scans/scans.service';
import { matchSuppression, type SuppressionRule } from '../scanning/suppression-matcher';
import { type DraftFinding } from '../scanning/types';
import { satisfies } from '../scanning/versions';

const PAGE = 500;
const MAX_PACKAGE_ROWS = 5000;

export function toFindingDto(f: Finding, repoFullName: string | null): FindingDto {
  return {
    id: f.id,
    repoId: f.repoId,
    repoFullName,
    scanner: f.scanner,
    ruleId: f.ruleId,
    title: f.title,
    description: f.description,
    severity: f.severity,
    riskScore: f.riskScore,
    riskFactors: f.riskFactors,
    status: f.status,
    path: f.path,
    line: f.line,
    package: f.package,
    advisory: f.advisory,
    secret: f.secret,
    details: f.details,
    remediation: f.remediation,
    suppressionId: f.suppressionId,
    firstSeenAt: f.firstSeenAt.toISOString(),
    lastSeenAt: f.lastSeenAt.toISOString(),
    fixedAt: f.fixedAt?.toISOString() ?? null,
  };
}

function canSeeFinding(user: User, f: Finding): boolean {
  const teams = visibleTeams(user);
  return !teams || (f.teamId !== null && teams.includes(f.teamId));
}

/** Adapts a stored finding to the matcher's input shape. */
function asDraft(f: Finding): DraftFinding {
  return { ...f, identity: [], risk: { base: 0, baseLabel: '' } };
}

@Injectable()
export class FindingsService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly audit: AuditService,
  ) {}

  private async repoNames(ids: string[]): Promise<Map<string, string>> {
    return new Map((await this.store.repositories.findByIds([...new Set(ids)])).map((r) => [r.id, r.fullName]));
  }

  async list(q: ListFindingsQuery, user: User): Promise<Paged<FindingDto>> {
    const page = await this.store.findings.list({
      repoId: q.repoId,
      scanner: q.scanner,
      severities: q.severity,
      status: q.status,
      search: q.search || undefined,
      visibleTeamIds: visibleTeams(user),
      offset: (q.page - 1) * q.pageSize,
      limit: q.pageSize,
    });
    const names = await this.repoNames(page.items.map((f) => f.repoId));
    return { items: page.items.map((f) => toFindingDto(f, names.get(f.repoId) ?? null)), total: page.total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string, user: User): Promise<FindingDto> {
    const f = await this.store.findings.findById(id);
    if (!f || !canSeeFinding(user, f)) throw new NotFoundException('Finding not found.');
    return toFindingDto(f, (await this.repoNames([f.repoId])).get(f.repoId) ?? null);
  }

  async summary(repoId: string | undefined, user: User): Promise<FindingSummary> {
    const s = await this.store.findings.summary({ repoId, visibleTeamIds: visibleTeams(user), fixedSince: new Date(Date.now() - 30 * 86_400_000) });
    return { open: s.open, openTotal: Object.values(s.open).reduce((a, b) => a + b, 0), suppressed: s.suppressed, fixedLast30Days: s.fixedSince, byScanner: s.byScanner };
  }

  async searchPackages(q: PackageSearchQuery, user: User): Promise<Paged<PackageUsageDto>> {
    let rows = await this.store.dependencies.search({ name: q.name, ecosystem: q.ecosystem, visibleTeamIds: visibleTeams(user), limit: MAX_PACKAGE_ROWS });
    if (q.version) {
      try {
        rows = rows.filter((d) => satisfies(d.ecosystem, d.version, q.version!));
      } catch {
        throw new BadRequestException('The version filter is not a valid range, e.g. "<4.17.21" or ">=2.0.0 <3.0.0".');
      }
    }
    const names = await this.repoNames(rows.map((r) => r.repoId));
    const items = rows
      .map((d) => ({ repoId: d.repoId, repoFullName: names.get(d.repoId) ?? '', ecosystem: d.ecosystem, name: d.name, version: d.version, direct: d.direct, dev: d.dev, manifestPath: d.manifestPath }))
      .sort((a, b) => a.repoFullName.localeCompare(b.repoFullName) || a.manifestPath.localeCompare(b.manifestPath));
    const start = (q.page - 1) * q.pageSize;
    return { items: items.slice(start, start + q.pageSize), total: items.length, page: q.page, pageSize: q.pageSize };
  }

  // ------------------------------------------------------------------ suppressions

  private async toSuppressionDto(s: Suppression, names?: Map<string, string>): Promise<SuppressionDto> {
    const repoNames = names ?? (s.repoId ? await this.repoNames([s.repoId]) : new Map<string, string>());
    return {
      id: s.id,
      repoId: s.repoId,
      repoFullName: s.repoId ? (repoNames.get(s.repoId) ?? null) : null,
      scanner: s.scanner,
      ruleId: s.ruleId,
      pathPattern: s.pathPattern,
      packageName: s.packageName,
      reason: s.reason,
      expiresAt: s.expiresAt?.toISOString() ?? null,
      createdBy: s.createdBy,
      createdByName: s.createdByName,
      createdAt: s.createdAt.toISOString(),
    };
  }

  /**
   * Updates every finding in a status that satisfies `predicate`. Updated findings leave the filtered
   * result set, so the offset only advances past rows that were left unchanged.
   */
  private async updateMatching(
    filter: { repoId?: string; status: 'open' | 'suppressed' },
    predicate: (f: Finding) => boolean,
    patch: Partial<Pick<Finding, 'status' | 'suppressionId'>>,
  ): Promise<number> {
    let changed = 0;
    let offset = 0;
    for (;;) {
      const page = await this.store.findings.list({ ...filter, offset, limit: PAGE });
      let changedHere = 0;
      for (const f of page.items) {
        if (!predicate(f)) continue;
        await this.store.findings.update(f.id, patch);
        changedHere++;
      }
      changed += changedHere;
      if (page.items.length < PAGE) return changed;
      offset += page.items.length - changedHere;
    }
  }

  async listSuppressions(repoId: string | undefined, user: User): Promise<SuppressionDto[]> {
    if (repoId) {
      const repo = await this.store.repositories.findById(repoId);
      if (!repo || !canSeeRepo(user, repo)) throw new NotFoundException('Repository not found.');
    }
    const all = await this.store.suppressions.list({ repoId });
    const repos = await this.store.repositories.findByIds(all.flatMap((s) => (s.repoId ? [s.repoId] : [])));
    const visible = new Map(repos.filter((r) => canSeeRepo(user, r)).map((r) => [r.id, r.fullName]));
    return Promise.all(all.filter((s) => !s.repoId || visible.has(s.repoId)).map((s) => this.toSuppressionDto(s, visible)));
  }

  async createSuppression(input: SuppressionInput, actor: User, ctx: RequestContext): Promise<SuppressionDto> {
    if (input.repoId) {
      const repo = await this.store.repositories.findById(input.repoId);
      if (!repo || !canSeeRepo(actor, repo)) throw new NotFoundException('Repository not found.');
    }
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new BadRequestException('The expiry date must be in the future.');
    const s = await this.store.suppressions.create({
      repoId: input.repoId,
      scanner: input.scanner ?? null,
      ruleId: input.ruleId ?? null,
      pathPattern: input.pathPattern ?? null,
      packageName: input.packageName ?? null,
      reason: input.reason,
      expiresAt: input.expiresAt ?? null,
      createdBy: actor.id,
      createdByName: actor.displayName,
    });
    // Apply right away rather than waiting for the next scan.
    const rule: SuppressionRule = { id: s.id, source: 'argus', scanner: s.scanner, ruleId: s.ruleId, pathPattern: s.pathPattern, packageName: s.packageName, reason: s.reason };
    const matched = await this.updateMatching({ repoId: s.repoId ?? undefined, status: 'open' }, (f) => !!matchSuppression([rule], f.scanner, asDraft(f)), { status: 'suppressed', suppressionId: s.id });
    await this.audit.record({
      action: 'suppression.created',
      actor,
      target: { type: 'suppression', id: s.id },
      details: { repoId: s.repoId, scanner: s.scanner, ruleId: s.ruleId, pathPattern: s.pathPattern, packageName: s.packageName, reason: s.reason, expiresAt: s.expiresAt, matched },
      ip: ctx.ip,
    });
    return { ...(await this.toSuppressionDto(s)), matchedFindings: matched };
  }

  async deleteSuppression(id: string, actor: User, ctx: RequestContext): Promise<{ reopened: number }> {
    const s = await this.store.suppressions.findById(id);
    if (!s) throw new NotFoundException('Suppression not found.');
    if (s.repoId) {
      const repo = await this.store.repositories.findById(s.repoId);
      if (repo && !canSeeRepo(actor, repo)) throw new NotFoundException('Suppression not found.');
    }
    await this.store.suppressions.delete(id);
    const reopened = await this.updateMatching({ repoId: s.repoId ?? undefined, status: 'suppressed' }, (f) => f.suppressionId === id, { status: 'open', suppressionId: null });
    await this.audit.record({ action: 'suppression.deleted', actor, target: { type: 'suppression', id }, details: { repoId: s.repoId, reason: s.reason, reopened }, ip: ctx.ip });
    return { reopened };
  }
}
