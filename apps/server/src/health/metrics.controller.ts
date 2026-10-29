import { Controller, Get, Header, Inject, NotFoundException, Req, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { type DataStore } from '@argus/data';
import { SEVERITIES } from '@argus/shared';
import { type Request } from 'express';
import { Public } from '../auth/decorators';
import { AppConfig } from '../config/app-config';
import { CryptoService } from '../core/crypto.service';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { WORKER_HEARTBEAT_KEY, type WorkerHeartbeat } from '../worker/worker.service';

const CACHE_MS = 15_000;

type Sample = { labels?: Record<string, string>; value: number };

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function metric(name: string, help: string, type: 'gauge' | 'counter', samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) {
    const labels = s.labels && Object.keys(s.labels).length ? `{${Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : '';
    lines.push(`${name}${labels} ${Number.isFinite(s.value) ? s.value : 0}`);
  }
  return lines.join('\n');
}

/**
 * Prometheus metrics (text exposition format) at /metrics. Off unless ARGUS_METRICS_TOKEN is set; scrapers send
 * it as a bearer token. Values are computed from the database, so every replica reports the same numbers.
 */
@Controller()
@Public()
@SkipThrottle()
export class MetricsController {
  private cache: { at: number; body: string } | null = null;

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly settings: SettingsService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async metrics(@Req() req: Request): Promise<string> {
    const expected = this.config.metricsToken;
    if (!expected) throw new NotFoundException();
    const given = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? '';
    if (!this.crypto.safeEqual(this.crypto.hash(given), this.crypto.hash(expected))) throw new UnauthorizedException();
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.body;
    const body = await this.collect();
    this.cache = { at: Date.now(), body };
    return body;
  }

  private async collect(): Promise<string> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [findings, tickets, activeRepos, allRepos, users, jobs, aiCost, intelItems, advisories, heartbeat] = await Promise.all([
      this.store.findings.summary({ fixedSince: new Date(now.getTime() - 7 * 86_400_000) }),
      this.store.tickets.summary({ userId: null, now }),
      this.store.repositories.list({ active: true, offset: 0, limit: 1 }),
      this.store.repositories.list({ offset: 0, limit: 1 }),
      this.store.users.count(),
      this.store.jobs.countByStatus(),
      this.store.aiUsage.totalCost(monthStart, now),
      this.store.intelItems.countByStatus(),
      this.store.advisories.countActive(),
      this.settings.getSystemValue<WorkerHeartbeat>(WORKER_HEARTBEAT_KEY),
    ]);
    const mem = process.memoryUsage();
    return (
      [
        metric('argus_info', 'Argus build and runtime information.', 'gauge', [{ labels: { version: this.config.version, role: this.config.role, database: this.store.kind }, value: 1 }]),
        metric('argus_findings_open', 'Open (unsuppressed) findings by severity.', 'gauge', SEVERITIES.map((s) => ({ labels: { severity: s }, value: findings.open[s] }))),
        metric('argus_findings_suppressed', 'Suppressed findings.', 'gauge', [{ value: findings.suppressed }]),
        metric('argus_findings_fixed_7d', 'Findings fixed in the last 7 days.', 'gauge', [{ value: findings.fixedSince }]),
        metric('argus_tickets_active', 'Active tickets by severity.', 'gauge', SEVERITIES.map((s) => ({ labels: { severity: s }, value: tickets.bySeverity[s] }))),
        metric('argus_tickets_sla_breached', 'Active tickets past their due date.', 'gauge', [{ value: tickets.slaBreached }]),
        metric('argus_repositories', 'Repositories known to Argus, by monitoring state.', 'gauge', [
          { labels: { state: 'active' }, value: activeRepos.total },
          { labels: { state: 'inactive' }, value: allRepos.total - activeRepos.total },
        ]),
        metric('argus_users', 'User accounts.', 'gauge', [{ value: users }]),
        metric('argus_jobs', 'Background jobs by type and status.', 'gauge', jobs.map((j) => ({ labels: { type: j.type, status: j.status }, value: j.count }))),
        metric('argus_ai_cost_usd_month', 'Estimated AI provider spend this calendar month (UTC).', 'gauge', [{ value: Math.round(aiCost * 1e6) / 1e6 }]),
        metric('argus_intel_items', 'Security news items by review status.', 'gauge', Object.entries(intelItems).map(([status, value]) => ({ labels: { status }, value }))),
        metric('argus_advisories_active', 'Active Argus advisories.', 'gauge', [{ value: advisories }]),
        metric('argus_worker_heartbeat_age_seconds', 'Seconds since a worker last reported in (-1 if never).', 'gauge', [{ value: heartbeat ? Math.round((now.getTime() - new Date(heartbeat.at).getTime()) / 1000) : -1 }]),
        metric('process_resident_memory_bytes', 'Resident memory of this process.', 'gauge', [{ value: mem.rss }]),
        metric('process_heap_used_bytes', 'V8 heap in use by this process.', 'gauge', [{ value: mem.heapUsed }]),
        metric('process_uptime_seconds', 'Seconds since this process started.', 'gauge', [{ value: Math.round(process.uptime()) }]),
      ].join('\n\n') + '\n'
    );
  }
}
