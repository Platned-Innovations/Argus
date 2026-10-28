import { hostname } from 'node:os';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type DataStore } from '@argus/data';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';

export const WORKER_HEARTBEAT_KEY = 'worker.heartbeat';
export interface WorkerHeartbeat {
  at: string;
  host: string;
  pid: number;
}

const HEARTBEAT_MS = 30_000;
const SESSION_CLEANUP_MS = 60 * 60_000;

/**
 * Background worker. Phase 0 runs housekeeping only; the job queue, scheduler and
 * scanners are registered here in later phases.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly settings: SettingsService,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log('Worker started');
    this.every(HEARTBEAT_MS, () => this.heartbeat());
    this.every(SESSION_CLEANUP_MS, () => this.cleanupSessions());
  }

  onApplicationShutdown(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private every(ms: number, task: () => Promise<void>): void {
    const run = () => task().catch((err: unknown) => this.logger.error({ err }, 'Housekeeping task failed'));
    void run();
    const timer = setInterval(run, ms);
    timer.unref();
    this.timers.push(timer);
  }

  private async heartbeat(): Promise<void> {
    await this.settings.setSystemValue<WorkerHeartbeat>(WORKER_HEARTBEAT_KEY, { at: new Date().toISOString(), host: hostname(), pid: process.pid });
  }

  private async cleanupSessions(): Promise<void> {
    // Keep expired sessions for a day so refresh-token reuse is still detectable shortly after expiry.
    const removed = await this.store.sessions.deleteExpired(new Date(Date.now() - 86_400_000));
    if (removed) this.logger.log(`Removed ${removed} expired sessions`);
  }
}
