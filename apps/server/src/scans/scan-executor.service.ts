import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type DataStore, type Job, type Repository, type ScanRun, type ScanStatsRecord } from '@argus/data';
import { Redactor } from '../common/redact';
import { AppConfig } from '../config/app-config';
import { DomainEvents } from '../core/domain-events';
import { DATA_STORE } from '../core/tokens';
import { type JobContext, JobRunner, PermanentJobError } from '../jobs/job-runner.service';
import { assertCloneUrlAllowed, ProviderError } from '../sources/providers';
import { SourcesService } from '../sources/sources.service';
import { GitError, runGit } from './git';
import { ScanPipeline } from '../scanning/scan-pipeline.service';
import { inventory, walkFiles } from './inventory';

export const SCAN_JOB = 'repo.scan';
const MAX_LOG_LINES = 500;

/**
 * Executes `repo.scan` jobs: shallow-clones the repository into an ephemeral workspace, runs the scanners,
 * records the outcome, and always deletes the workspace.
 */
@Injectable()
export class ScanExecutor implements OnModuleInit {
  private readonly logger = new Logger('ScanExecutor');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly sources: SourcesService,
    private readonly runner: JobRunner,
    private readonly config: AppConfig,
    private readonly pipeline: ScanPipeline,
    private readonly events: DomainEvents,
  ) {}

  onModuleInit(): void {
    this.runner.register(SCAN_JOB, (job, ctx) => this.execute(job, ctx));
  }

  async execute(job: Job, jobCtx: JobContext): Promise<void> {
    const run = await this.store.scanRuns.findById(String(job.payload.runId));
    if (!run || run.status === 'succeeded' || run.status === 'cancelled') return;
    const repo = await this.store.repositories.findById(run.repoId);
    const source = repo ? await this.store.sources.findById(repo.sourceId) : null;

    const lines = [...run.log];
    let redactor = new Redactor();
    const log = (message: string) => {
      if (lines.length < MAX_LOG_LINES) lines.push(`${new Date().toISOString()} ${redactor.redact(message)}`);
    };
    const started = Date.now();

    if (!repo || !source || repo.removedAt) {
      await this.finish(run, repo, 'failed', lines, started, { error: 'The repository no longer exists in its source.' });
      return;
    }

    const conn = this.sources.connection(source);
    const client = this.sources.clientFor(source);
    const authHeader = client.gitAuthHeader();
    redactor = new Redactor([conn.token, authHeader, authHeader.replace(/^Authorization:\s*\S+\s+/, '')]);
    const workdir = join(this.config.scanWorkdir, run.id);
    let stats: ScanStatsRecord | null = null;

    await this.store.scanRuns.update(run.id, { status: 'running', startedAt: new Date(started), attempts: job.attempts, error: null });
    log(`Scan started (attempt ${job.attempts} of ${job.maxAttempts}) for ${repo.fullName}`);

    try {
      const cloneUrl = assertCloneUrlAllowed(client, repo.cloneUrl);
      await mkdir(this.config.scanWorkdir, { recursive: true });
      await rm(workdir, { recursive: true, force: true });

      const branch = repo.branch ?? repo.defaultBranch;
      log(`Cloning ${cloneUrl.host}${cloneUrl.pathname}${branch ? ` (branch ${branch})` : ' (default branch)'}`);
      await this.clone(cloneUrl.toString(), branch, workdir, authHeader, log);
      const commitSha = await runGit(['rev-parse', 'HEAD'], { cwd: workdir, home: this.config.scanWorkdir, timeoutMs: 30_000 });
      const checkedOut = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir, home: this.config.scanWorkdir, timeoutMs: 30_000 });
      log(`Checked out ${checkedOut} at ${commitSha}`);
      await this.store.scanRuns.update(run.id, { commitSha, branch: checkedOut, log: lines });

      const files = await walkFiles(workdir);
      stats = inventory(files);
      log(`Inventory: ${stats.files} files, ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB; ecosystems: ${stats.ecosystems.join(', ') || 'none detected'}`);
      const result = await this.pipeline.run(repo, run, workdir, files, log);
      stats = { ...stats, ...result.stats };
      for (const w of result.warnings) log(`Warning: ${w}`);
      const f = result.stats.findings;
      log(`Scan completed: ${f ? `${f.new} new, ${f.fixed} fixed, ${f.reopened} reopened` : 'no findings recorded'}`);
      await this.finish(run, repo, 'succeeded', lines, started, { stats });
    } catch (err) {
      const permanent = (err instanceof ProviderError && err.permanent) || (err instanceof GitError && /authentication failed|could not read username|not found|403/i.test(err.message));
      const message = redactor.redact(err instanceof Error ? err.message : String(err));
      log(`Error: ${message}`);
      if (permanent || jobCtx.finalAttempt) {
        await this.finish(run, repo, 'failed', lines, started, { error: message, stats });
        await this.events.emit('scan.failed', { repo, run, error: message });
        throw new PermanentJobError(message);
      }
      log('Will retry later');
      await this.store.scanRuns.update(run.id, { status: 'queued', error: message, log: lines });
      throw new Error(message);
    } finally {
      // The checked-out source code is never kept.
      await rm(workdir, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) => this.logger.error({ err, workdir }, 'Failed to delete scan workspace'));
    }
  }

  private async clone(url: string, branch: string | null, dir: string, authHeader: string, log: (m: string) => void): Promise<void> {
    const common = ['-c', 'core.symlinks=false', '-c', 'advice.detachedHead=false', 'clone', '--single-branch', '--no-tags', ...(branch ? ['--branch', branch] : [])];
    const opts = { home: this.config.scanWorkdir, authHeader, timeoutMs: this.config.scanTimeoutMs };
    try {
      await runGit([...common, '--depth', '1', '--', url, dir], opts);
    } catch (err) {
      // Some servers (and git's "dumb" HTTP protocol) cannot do shallow clones.
      if (err instanceof GitError && /shallow/i.test(err.stderr)) {
        log('Server does not support shallow clones; retrying with a full clone of the branch');
        await rm(dir, { recursive: true, force: true });
        await runGit([...common, '--', url, dir], opts);
        return;
      }
      throw err;
    }
  }

  private async finish(
    run: ScanRun,
    repo: Repository | null,
    status: 'succeeded' | 'failed',
    lines: string[],
    started: number,
    extra: { error?: string; stats?: ScanStatsRecord | null },
  ): Promise<void> {
    const finishedAt = new Date();
    await this.store.scanRuns.update(run.id, {
      status,
      finishedAt,
      durationMs: finishedAt.getTime() - started,
      error: extra.error ?? null,
      stats: extra.stats ?? null,
      log: lines,
    });
    if (repo) await this.store.repositories.update(repo.id, { lastScanAt: finishedAt, lastScanStatus: status, lastScanRunId: run.id });
  }
}
