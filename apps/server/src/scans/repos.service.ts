import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type DataStore, type Provider, type Repository, type RepositoryPatch, type User } from '@argus/data';
import { type ListReposQuery, type Paged, type RepoBulkUpdateInput, type RepositoryDto, type RepoUpdateInput, type ScanRunDto } from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
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
    for (const repo of repos) await this.store.repositories.update(repo.id, await this.buildPatch(repo, input.patch));
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

  private async buildPatch(repo: Repository, input: RepoUpdateInput): Promise<RepositoryPatch> {
    if (input.teamId && !(await this.store.teams.findById(input.teamId))) throw new BadRequestException('The team does not exist.');
    if (input.schedule?.preset === 'custom') {
      const error = validateCron(input.schedule.cron ?? '');
      if (error) throw new BadRequestException({ statusCode: 400, message: error, issues: [{ path: 'schedule.cron', message: error }] });
    }
    if (input.active && repo.removedAt) throw new ConflictException(`${repo.fullName} is no longer available from its source and cannot be activated.`);

    const patch: RepositoryPatch = {};
    for (const key of ['active', 'teamId', 'criticality', 'branch', 'scanOnPush', 'jiraProjectKey', 'notifyEmails'] as const) {
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
