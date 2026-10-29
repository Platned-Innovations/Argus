import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type DataStore, type Dependency, type Job, type Repository } from '@argus/data';
import { DEFAULT_INTEL_SETTINGS, type EmergingThreatDto, type IntelSettings, intelSettingsSchema, type RematchRunDto } from '@argus/shared';
import { DomainEvents, type EmergingThreat } from '../core/domain-events';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { JobRunner } from '../jobs/job-runner.service';
import { IntelService } from '../scanning/intel.service';
import { toObservedFinding } from '../scanning/observe';
import { EMPTY_REPO_CONFIG } from '../scanning/repo-config';
import { buildSuppressionRules } from '../scanning/suppression-matcher';
import { type InventoryItem } from '../scanning/types';
import { matchVulnerabilities } from '../scanning/vulnerability-matcher';
import { severityRank } from '../tickets/ticket-rules';

export const REMATCH_JOB = 'intel.rematch';
const SETTINGS_KEY = 'intel';
const LAST_RUN_KEY = 'intel.lastRematch';
const LAST_SCHEDULED_KEY = 'intel.lastScheduledRematch';
const EMERGING_KEY = 'intel.emerging';
const MAX_EMERGING = 50;
const PAGE = 500;

interface RematchPayload {
  trigger: RematchRunDto['trigger'];
}

/**
 * Continuous re-matching: checks every active repository's stored dependency inventory against the advisory
 * data, without cloning. New vulnerabilities (published since the last scan, or added as Argus advisories) become
 * findings straight away, tickets follow through `findings.changed`, and an `intel.emerging_threats` event is raised.
 */
@Injectable()
export class RematchService implements OnModuleInit {
  private readonly logger = new Logger('Rematch');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly intel: IntelService,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    private readonly runner: JobRunner,
  ) {}

  onModuleInit(): void {
    this.runner.register(REMATCH_JOB, (job) => this.handle(job));
    this.events.on('scheduler.tick', async ({ now }) => {
      const s = await this.intelSettings();
      const last = await this.settings.getSystemValue<string>(LAST_SCHEDULED_KEY);
      if (last && now.getTime() - new Date(last).getTime() < s.rematchIntervalHours * 3_600_000) return;
      await this.settings.setSystemValue(LAST_SCHEDULED_KEY, now.toISOString());
      await this.enqueue('schedule');
    });
  }

  async intelSettings(): Promise<IntelSettings> {
    const v = (await this.store.settings.get<Partial<IntelSettings>>(SETTINGS_KEY))?.value ?? {};
    const parsed = intelSettingsSchema.safeParse({ ...DEFAULT_INTEL_SETTINGS, ...v });
    return parsed.success ? parsed.data : DEFAULT_INTEL_SETTINGS;
  }

  async enqueue(trigger: RematchRunDto['trigger']): Promise<void> {
    // One pending run per kind is enough. Runs that refresh OSV data are kept apart from database-only runs for new
    // Argus advisories, so a pending advisory run never swallows a refresh.
    await this.store.jobs.enqueue({ type: REMATCH_JOB, payload: { trigger }, dedupeKey: trigger === 'advisory' ? 'intel:rematch:advisory' : 'intel:rematch:osv', priority: trigger === 'schedule' ? 0 : 1, maxAttempts: 2 });
    this.runner.poke();
  }

  lastRun(): Promise<RematchRunDto | null> {
    return this.settings.getSystemValue<RematchRunDto>(LAST_RUN_KEY);
  }

  async emerging(): Promise<EmergingThreatDto[]> {
    return (await this.settings.getSystemValue<EmergingThreatDto[]>(EMERGING_KEY)) ?? [];
  }

  private async handle(job: Job): Promise<void> {
    const { trigger } = job.payload as unknown as RematchPayload;
    const result: RematchRunDto = { at: new Date().toISOString(), trigger, packages: 0, repos: 0, newFindings: 0, error: null };
    try {
      await this.run(trigger, result);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await this.settings.setSystemValue(LAST_RUN_KEY, result);
    }
  }

  private async activeRepos(): Promise<Repository[]> {
    const out: Repository[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.store.repositories.list({ active: true, offset, limit: PAGE });
      out.push(...page.items);
      if (page.items.length < PAGE) return out;
    }
  }

  private async inventory(repoId: string): Promise<Dependency[]> {
    const out: Dependency[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.store.dependencies.listForRepo(repoId, { offset, limit: 1000 });
      out.push(...page.items);
      if (page.items.length < 1000) return out;
    }
  }

  async run(trigger: RematchRunDto['trigger'], result: RematchRunDto): Promise<void> {
    const now = new Date();
    const scanning = await this.settings.getScanning();
    const repos = await this.activeRepos();
    const inventories = new Map<string, InventoryItem[]>();
    for (const repo of repos) {
      // A repository being scanned right now gets fresh results from that scan.
      if (await this.store.scanRuns.findActiveForRepo(repo.id)) continue;
      const deps = await this.inventory(repo.id);
      if (deps.length) inventories.set(repo.id, deps.map((d) => ({ ...d, vulnerabilities: 0 })));
    }
    const all = [...inventories.values()].flat();
    result.packages = new Set(all.map((d) => `${d.ecosystem}|${d.name}|${d.version}`)).size;
    result.repos = inventories.size;
    if (!all.length) return;

    // Scheduled and manual runs refresh OSV results for every package once; per-repository matching then reads the cache.
    // A run triggered by a new Argus advisory only needs the database.
    if (trigger !== 'advisory') await this.intel.queryVulnerabilities(all, { fresh: true });

    const threats = new Map<string, EmergingThreat>();
    const changed: string[] = [];
    for (const repo of repos) {
      const inv = inventories.get(repo.id);
      if (!inv) continue;
      const match = await matchVulnerabilities(this.intel, inv, { nvdLookups: 20 });
      if (match.incomplete) throw new Error(match.problems.join('; '));
      const rules = buildSuppressionRules(repo.id, await this.store.suppressions.listApplicable(repo.id, now), EMPTY_REPO_CONFIG, now);
      const existing = new Map((await this.store.findings.listAllForRepo(repo.id)).map((f) => [f.fingerprint, f]));
      // New issues, and ones a scan marked fixed while the inventory still contains the vulnerable version.
      const fresh = match.findings
        .map((d) => toObservedFinding(repo, 'dependencies', d, scanning.riskWeights, rules))
        .filter((o) => {
          const f = existing.get(o.fingerprint);
          return !f || f.status === 'fixed';
        });
      if (!fresh.length) continue;
      await this.store.findings.reconcile({ repoId: repo.id, sourceId: repo.sourceId, teamId: repo.teamId, runId: randomUUID(), scanners: [], now }, fresh);
      changed.push(repo.id);
      result.newFindings += fresh.length;
      for (const o of fresh) {
        if (o.suppressionId || !o.advisory || !o.package) continue;
        const key = `${o.advisory.id}|${o.package.ecosystem}|${o.package.name.toLowerCase()}`;
        const t = threats.get(key) ?? {
          advisoryId: o.advisory.id,
          argusAdvisoryId: typeof o.details?.argusAdvisory === 'string' ? o.details.argusAdvisory : null,
          title: match.advisoryTitles.get(o.advisory.id) ?? o.advisory.id,
          severity: o.severity,
          ecosystem: o.package.ecosystem,
          packageName: o.package.name,
          repos: 0,
          findings: 0,
          at: now.toISOString(),
          repoIds: [],
          teamIds: [],
        };
        if (severityRank(o.severity) > severityRank(t.severity)) t.severity = o.severity;
        t.findings++;
        if (!t.repoIds.includes(repo.id)) {
          t.repoIds.push(repo.id);
          t.teamIds.push(repo.teamId);
          t.repos++;
        }
        threats.set(key, t);
      }
    }

    if (changed.length) await this.events.emit('findings.changed', { repoIds: changed });
    if (threats.size) {
      const list = [...threats.values()];
      const history = await this.emerging();
      await this.settings.setSystemValue(EMERGING_KEY, [...list.map(({ repoIds: _r, teamIds: _t, ...dto }) => dto), ...history].slice(0, MAX_EMERGING));
      await this.events.emit('intel.emerging_threats', { threats: list });
      this.logger.log(`Re-matching found ${result.newFindings} new finding(s) from ${list.length} advisory/advisories in ${changed.length} repository(ies)`);
    }
  }
}
