import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type DataStore, type Dependency, type Finding, type Provider, type Repository, type RepositoryPatch, type User } from '@argus/data';
import { type DependencyDto, type ListDependenciesQuery, type ListReposQuery, type Paged, type RepoBulkUpdateInput, type RepositoryDto, type RepoUpdateInput, type ScanRunDto } from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { buildCycloneDx } from '../findings/sbom';
import { DATA_STORE } from '../core/tokens';
import { toRepositoryDto, toScanRunDto } from './mappers';
import { canSeeRepo, ScansService, visibleTeams } from './scans.service';
import { nextRunAt, validateCron } from './schedule';

@Injectable()
export class ReposService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly scans: ScansService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private async providers(): Promise<Map<string, Provider>> {
    return new Map((await this.store.sources.list()).map((s) => [s.id, s.provider]));
  }

  async list(q: ListReposQuery, user: User): Promise<Paged<RepositoryDto>> {
    const [page, providers] = await Promise.all([
      this.store.repositories.list({
        search: q.search || undefined,
        sourceId: q.sourceId,
        teamId: q.teamId,
        active: q.active,
        visibleTeamIds: visibleTeams(user),
        offset: (q.page - 1) * q.pageSize,
        limit: q.pageSize,
      }),
      this.providers(),
    ]);
    return { items: page.items.map((r) => toRepositoryDto(r, providers.get(r.sourceId)!)), total: page.total, page: q.page, pageSize: q.pageSize };
  }

  /** Loads a repository the user may see; others get a 404 so their existence is not revealed. */
  async require(id: string, user: User): Promise<Repository> {
    const repo = await this.store.repositories.findById(id);
    if (!repo || !canSeeRepo(user, repo)) throw new NotFoundException('Repository not found.');
    return repo;
  }

  async get(id: string, user: User): Promise<RepositoryDto> {
    const repo = await this.require(id, user);
    return toRepositoryDto(repo, (await this.providers()).get(repo.sourceId)!);
  }

  async update(id: string, input: RepoUpdateInput, actor: User, ctx: RequestContext): Promise<RepositoryDto> {
    const repo = await this.require(id, actor);
    const patch = await this.buildPatch(repo, input);
    const updated = (await this.store.repositories.update(id, patch))!;
    await this.cascadeTeam(repo, patch);
    await this.audit.record({
      action: 'repo.updated',
      actor,
      target: { type: 'repository', id },
      details: { fullName: repo.fullName, changed: Object.keys(input), ...(input.active !== undefined ? { active: input.active } : {}) },
      ip: ctx.ip,
    });
    return toRepositoryDto(updated, (await this.providers()).get(updated.sourceId)!);
  }

  async bulkUpdate(input: RepoBulkUpdateInput, actor: User, ctx: RequestContext): Promise<{ updated: number }> {
    const repos = (await this.store.repositories.findByIds([...new Set(input.ids)])).filter((r) => canSeeRepo(actor, r));
    for (const repo of repos) {
      const patch = await this.buildPatch(repo, input.patch);
      await this.store.repositories.update(repo.id, patch);
      await this.cascadeTeam(repo, patch);
    }
    await this.audit.record({ action: 'repo.bulk_updated', actor, details: { count: repos.length, changed: Object.keys(input.patch), patch: input.patch }, ip: ctx.ip });
    return { updated: repos.length };
  }

  async scanNow(id: string, actor: User, ctx: RequestContext): Promise<{ run: ScanRunDto; alreadyQueued: boolean }> {
    const repo = await this.require(id, actor);
    if (repo.removedAt) throw new ConflictException('This repository is no longer available from its source.');
    const { run, created } = await this.scans.enqueue(repo, 'manual', actor.id);
    if (!run) throw new ConflictException('A scan is already in progress.');
    if (created) await this.audit.record({ action: 'scan.requested', actor, target: { type: 'repository', id }, details: { fullName: repo.fullName, runId: run.id }, ip: ctx.ip });
    return { run: toScanRunDto(run, repo.fullName), alreadyQueued: !created };
  }

  /** Findings, inventory and scan history follow the repository to its new team, so visibility stays consistent. */
  private async cascadeTeam(repo: Repository, patch: RepositoryPatch): Promise<void> {
    if (patch.teamId === undefined || patch.teamId === repo.teamId) return;
    await Promise.all([
      this.store.findings.setTeamForRepo(repo.id, patch.teamId),
      this.store.dependencies.setTeamForRepo(repo.id, patch.teamId),
      this.store.scanRuns.setTeamForRepo(repo.id, patch.teamId),
    ]);
  }

  async dependencies(id: string, q: ListDependenciesQuery, user: User): Promise<Paged<DependencyDto>> {
    await this.require(id, user);
    const page = await this.store.dependencies.listForRepo(id, { search: q.search || undefined, ecosystem: q.ecosystem, vulnerableOnly: q.vulnerableOnly, offset: (q.page - 1) * q.pageSize, limit: q.pageSize });
    return {
      items: page.items.map((d) => ({
        ecosystem: d.ecosystem,
        name: d.name,
        version: d.version,
        direct: d.direct,
        dev: d.dev,
        license: d.license,
        manifestPath: d.manifestPath,
        latestVersion: d.latestVersion,
        deprecated: d.deprecated,
        vulnerabilities: d.vulnerabilities,
      })),
      total: page.total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async sbom(id: string, user: User, ctx: RequestContext) {
    const repo = await this.require(id, user);
    const deps: Dependency[] = [];
    for (let offset = 0; ; offset += 5000) {
      const page = await this.store.dependencies.listForRepo(id, { offset, limit: 5000 });
      deps.push(...page.items);
      if (page.items.length < 5000) break;
    }
    const vulns: Finding[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.store.findings.list({ repoId: id, scanner: 'dependencies', status: 'open', offset, limit: 1000 });
      vulns.push(...page.items.filter((f) => f.advisory));
      if (page.items.length < 1000) break;
    }
    await this.audit.record({ action: 'repo.sbom_exported', actor: user, target: { type: 'repository', id }, details: { fullName: repo.fullName, components: deps.length }, ip: ctx.ip });
    return { fileName: `${repo.fullName.replace(/[^\w.-]+/g, '_')}.cdx.json`, document: buildCycloneDx(repo, deps, vulns, { version: this.config.version }, randomUUID()) };
  }

  private async buildPatch(repo: Repository, input: RepoUpdateInput): Promise<RepositoryPatch> {
    if (input.teamId && !(await this.store.teams.findById(input.teamId))) throw new BadRequestException('The team does not exist.');
    if (input.schedule?.preset === 'custom') {
      const error = validateCron(input.schedule.cron ?? '');
      if (error) throw new BadRequestException({ statusCode: 400, message: error, issues: [{ path: 'schedule.cron', message: error }] });
    }
    if (input.active && repo.removedAt) throw new ConflictException(`${repo.fullName} is no longer available from its source and cannot be activated.`);

    const patch: RepositoryPatch = {};
    for (const key of ['active', 'teamId', 'criticality', 'branch', 'scanOnPush', 'jiraProjectKey', 'notifyEmails', 'disabledScanners'] as const) {
      if (input[key] !== undefined) Object.assign(patch, { [key]: input[key] });
    }
    if (input.schedule) patch.schedule = { preset: input.schedule.preset, cron: input.schedule.preset === 'custom' ? input.schedule.cron : null };

    const active = input.active ?? repo.active;
    const schedule = patch.schedule ?? repo.schedule;
    if (!active) patch.nextScanAt = null;
    // Newly activated repositories are scanned straight away, then follow their schedule.
    else if (input.active && !repo.active) patch.nextScanAt = new Date();
    else if (input.schedule) patch.nextScanAt = nextRunAt(schedule, repo.id);
    return patch;
  }
}
