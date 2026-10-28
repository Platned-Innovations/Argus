import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type DataStore, type Job } from '@argus/data';
import { AppConfig } from '../config/app-config';
import { DATA_STORE } from '../core/tokens';

export interface JobContext {
  /** True when a failure now will not be retried. */
  finalAttempt: boolean;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

/** Throw to fail a job without retrying (e.g. bad credentials, deleted repository). */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
}

const LEASE_MS = 5 * 60_000;
const POLL_MS = 2_000;
const SHUTDOWN_GRACE_MS = 25_000;

/** Exponential backoff: 1, 4, 16 minutes ... capped at 1 hour. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 4 ** Math.max(0, attempt - 1));
}

/**
 * Database-backed job worker. Leases jobs, keeps the lease alive while a handler runs,
 * retries failures with backoff, and lets another worker take over if this process dies.
 * Started only in the `all` and `worker` roles.
 */
@Injectable()
export class JobRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('JobRunner');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly active = new Set<Promise<void>>();
  readonly workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private running = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly config: AppConfig,
  ) {}

  /** Register during onModuleInit so handlers exist before the runner starts. */
  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  onApplicationBootstrap(): void {
    if (this.config.role === 'api') return;
    this.running = true;
    this.loop = this.run();
    this.logger.log(`Job runner ${this.workerId} started (concurrency ${this.config.workerConcurrency}; ${[...this.handlers.keys()].join(', ')})`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    // Unfinished jobs keep their lease until it expires and are then picked up by another worker.
    await Promise.race([Promise.allSettled([...this.active]), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref())]);
  }

  /** Nudge the runner to poll immediately (e.g. right after enqueueing in the same process). */
  poke(): void {
    this.wake?.();
  }

  private async run(): Promise<void> {
    const types = [...this.handlers.keys()];
    while (this.running) {
      let claimed = false;
      if (this.active.size < this.config.workerConcurrency) {
        try {
          const job = await this.store.jobs.claim(types, this.workerId, LEASE_MS);
          if (job) {
            claimed = true;
            const p = this.execute(job).finally(() => {
              this.active.delete(p);
              this.wake?.();
            });
            this.active.add(p);
          }
        } catch (err) {
          this.logger.error({ err }, 'Failed to claim a job');
        }
      }
      if (!claimed) await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, POLL_MS);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private async execute(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    const heartbeat = setInterval(() => {
      this.store.jobs.extendLease(job.id, this.workerId, LEASE_MS).catch((err: unknown) => this.logger.warn({ err, jobId: job.id }, 'Could not extend job lease'));
    }, LEASE_MS / 3);
    heartbeat.unref();
    const finalAttempt = job.attempts >= job.maxAttempts;
    try {
      if (!handler) throw new PermanentJobError(`No handler for job type ${job.type}`);
      await handler(job, { finalAttempt });
      await this.store.jobs.complete(job.id, this.workerId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = !(err instanceof PermanentJobError) && !finalAttempt;
      const retryAt = retry ? new Date(Date.now() + retryDelayMs(job.attempts)) : null;
      await this.store.jobs.fail(job.id, this.workerId, message.slice(0, 2000), retryAt).catch(() => undefined);
      this.logger.warn({ jobId: job.id, type: job.type, attempt: job.attempts, retryAt }, `Job failed: ${message}`);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
