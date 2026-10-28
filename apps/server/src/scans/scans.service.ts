import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type DataStore, type Repository, type ScanRun, type ScanTrigger, type User } from '@argus/data';
import { hasGlobalScope, type ListScanRunsQuery, type Paged, type ScanRunDto } from '@argus/shared';
import { DATA_STORE } from '../core/tokens';
import { JobRunner } from '../jobs/job-runner.service';
import { toScanRunDto } from './mappers';
import { SCAN_JOB } from './scan-executor.service';

const PRIORITY: Record<ScanTrigger, number> = { manual: 10, push: 5, activation: 3, schedule: 0 };

/** Team ids the user may see, or undefined for roles with organisation-wide visibility. */
export function visibleTeams(user: User): string[] | undefined {
  return hasGlobalScope(user.role) ? undefined : user.teamIds;
}

export function canSeeRepo(user: User, repo: Repository): boolean {
  const teams = visibleTeams(user);
  return !teams || (repo.teamId !== null && teams.includes(repo.teamId));
}

@Injectable()
export class ScansService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly runner: JobRunner,
  ) {}

  /**
   * Queues a scan unless one is already queued or running for the repository.
   * Returns the run that will cover this request and whether it was newly created.
   */
  async enqueue(repo: Repository, trigger: ScanTrigger, requestedBy: string | null): Promise<{ run: ScanRun | null; created: boolean }> {
    const existing = await this.store.scanRuns.findActiveForRepo(repo.id);
    if (existing) return { run: existing, created: false };
    const run = await this.store.scanRuns.create({ repoId: repo.id, sourceId: repo.sourceId, teamId: repo.teamId, trigger, requestedBy, branch: repo.branch ?? repo.defaultBranch });
    const job = await this.store.jobs.enqueue({ type: SCAN_JOB, payload: { runId: run.id }, dedupeKey: `scan:${repo.id}`, priority: PRIORITY[trigger], maxAttempts: 2 });
    if (!job) {
      // Lost a race with a concurrent enqueue for the same repository.
      await this.store.scanRuns.delete(run.id);
      return { run: await this.store.scanRuns.findActiveForRepo(repo.id), created: false };
    }
    this.runner.poke();
    return { run, created: true };
  }

  async list(q: ListScanRunsQuery, user: User): Promise<Paged<ScanRunDto>> {
    const page = await this.store.scanRuns.list({ repoId: q.repoId, status: q.status, visibleTeamIds: visibleTeams(user), offset: (q.page - 1) * q.pageSize, limit: q.pageSize });
    const repos = new Map((await this.store.repositories.findByIds([...new Set(page.items.map((r) => r.repoId))])).map((r) => [r.id, r.fullName]));
    return { items: page.items.map((r) => toScanRunDto(r, repos.get(r.repoId) ?? null)), total: page.total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string, user: User): Promise<ScanRunDto> {
    const run = await this.store.scanRuns.findById(id);
    const repo = run ? await this.store.repositories.findById(run.repoId) : null;
    if (!run || !repo || !canSeeRepo(user, repo)) throw new NotFoundException('Scan run not found.');
    return toScanRunDto(run, repo.fullName, true);
  }
}
