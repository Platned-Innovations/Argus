import { Controller, Get, Inject, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { type DataStore } from '@argus/data';
import { type Response } from 'express';
import { Public } from '../auth/decorators';
import { AppConfig } from '../config/app-config';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { WORKER_HEARTBEAT_KEY, type WorkerHeartbeat } from '../worker/worker.service';

@Controller()
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
  ) {}

  /** Liveness: the process is up. */
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  /** Readiness: the database is reachable. Worker heartbeat is informational. */
  @Get('readyz')
  async readyz(@Res({ passthrough: true }) res: Response) {
    const db = await this.store.ping();
    const heartbeat = db ? await this.settings.getSystemValue<WorkerHeartbeat>(WORKER_HEARTBEAT_KEY).catch(() => null) : null;
    res.status(db ? 200 : 503);
    return {
      status: db ? 'ok' : 'unavailable',
      version: this.config.version,
      role: this.config.role,
      database: { type: this.store.kind, ok: db },
      worker: heartbeat ? { lastSeen: heartbeat.at, host: heartbeat.host } : null,
    };
  }
}
