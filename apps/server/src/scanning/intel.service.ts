import { Inject, Injectable, Logger } from '@nestjs/common';
import { type DataStore } from '@argus/data';
import { type Ecosystem } from '@argus/shared';
import { AppConfig } from '../config/app-config';
import { DATA_STORE } from '../core/tokens';
import { highestStable } from './versions';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TIMEOUT_MS = 30_000;
const OSV_BATCH = 500;
const EPSS_BATCH = 100;
const CONCURRENCY = 8;

export class IntelError extends Error {
  override name = 'IntelError';
}

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  modified: string;
  published?: string;
  withdrawn?: string;
  severity?: { type: string; score: string }[];
  affected?: { package?: { ecosystem: string; name: string }; ranges?: { type: string; events: OsvEvent[] }[]; versions?: string[]; severity?: { type: string; score: string }[] }[];
  references?: { type: string; url: string }[];
  database_specific?: { severity?: string };
}

export interface EolCycle {
  cycle: string;
  eol: string | boolean;
  latest?: string;
  lts?: string | boolean;
  releaseDate?: string;
  support?: string | boolean;
}

export interface PackageMeta {
  latest: string | null;
  /** Deprecation message for the requested version, if the registry has one. */
  deprecated: string | null;
}

export interface FeedStatus {
  fetchedAt: string;
  entries: number | null;
  error: string | null;
}

export interface PackageRef {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: 'npm', nuget: 'NuGet' };

export const packageKey = (p: PackageRef) => `${p.ecosystem}|${p.ecosystem === 'nuget' ? p.name.toLowerCase() : p.name}|${p.version}`;

/** Runs `fn` over items with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Threat-intelligence lookups with a database-backed cache so repeated scans (and several workers)
 * do not hammer public APIs. Every external base URL is configurable for mirrors and tests.
 */
@Injectable()
export class IntelService {
  private readonly logger = new Logger('Intel');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly config: AppConfig,
  ) {}

  get offline(): boolean {
    return this.config.offline;
  }

  private async fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    if (this.config.offline) throw new IntelError('Argus is running in offline mode (ARGUS_OFFLINE=true).');
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { Accept: 'application/json', 'User-Agent': 'Argus', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
      throw new IntelError(`Could not reach ${new URL(url).host}: ${cause}`);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      throw new IntelError(`404 from ${new URL(url).host}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new IntelError(`${new URL(url).host} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.store.cache.get<T>(key);
    if (hit && hit.expiresAt.getTime() > Date.now()) return hit.value;
    try {
      const value = await load();
      await this.store.cache.set(key, value, ttlMs);
      return value;
    } catch (err) {
      // Serve stale data rather than nothing when a feed is temporarily unavailable.
      if (hit) {
        this.logger.warn(`Using stale ${key}: ${err instanceof Error ? err.message : String(err)}`);
        return hit.value;
      }
      throw err;
    }
  }

  private async recordFeed(key: string, status: FeedStatus): Promise<void> {
    await this.store.cache.set(`feed:${key}`, status, 365 * DAY);
  }

  async feedStatus(keys: string[]): Promise<Map<string, FeedStatus>> {
    const entries = await this.store.cache.getMany<FeedStatus>(keys.map((k) => `feed:${k}`));
    return new Map([...entries.values()].map((e) => [e.key.slice(5), e.value]));
  }

  /** OSV.dev batch query. Returns vulnerability ids per package version (OSV evaluates the version ranges). */
  async queryVulnerabilities(packages: PackageRef[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const unique = [...new Map(packages.map((p) => [packageKey(p), p])).values()];
    const cached = await this.store.cache.getMany<string[]>(unique.map((p) => `osvq:${packageKey(p)}`));
    const todo: PackageRef[] = [];
    for (const p of unique) {
      const hit = cached.get(`osvq:${packageKey(p)}`);
      if (hit && hit.expiresAt.getTime() > Date.now()) out.set(packageKey(p), hit.value);
      else todo.push(p);
    }
    try {
      for (let i = 0; i < todo.length; i += OSV_BATCH) {
        const batch = todo.slice(i, i + OSV_BATCH);
        const res = await this.fetchJson<{ results: { vulns?: { id: string }[] }[] }>(`${this.config.intel.osv}/v1/querybatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queries: batch.map((p) => ({ package: { ecosystem: OSV_ECOSYSTEM[p.ecosystem], name: p.name }, version: p.version })) }),
        });
        await Promise.all(
          batch.map(async (p, idx) => {
            const ids = (res.results[idx]?.vulns ?? []).map((v) => v.id);
            out.set(packageKey(p), ids);
            await this.store.cache.set(`osvq:${packageKey(p)}`, ids, 12 * HOUR);
          }),
        );
      }
      await this.recordFeed('osv', { fetchedAt: new Date().toISOString(), entries: null, error: null });
    } catch (err) {
      await this.recordFeed('osv', { fetchedAt: new Date().toISOString(), entries: null, error: String((err as Error).message) });
      throw err;
    }
    return out;
  }

  async vulnerabilities(ids: string[]): Promise<Map<string, OsvVuln>> {
    const unique = [...new Set(ids)];
    const results = await mapLimit(unique, CONCURRENCY, async (id) => {
      const v = await this.cached<OsvVuln>(`osv:${id}`, DAY, async () => {
        const full = await this.fetchJson<OsvVuln>(`${this.config.intel.osv}/v1/vulns/${encodeURIComponent(id)}`);
        // Long write-ups are not needed for matching; keep storage bounded.
        return { ...full, details: full.details?.slice(0, 4000) };
      });
      return [id, v] as const;
    });
    return new Map(results);
  }

  /** CVE ids in CISA's Known Exploited Vulnerabilities catalog. */
  async kev(): Promise<Set<string>> {
    const list = await this.cached<string[]>('kev', 12 * HOUR, async () => {
      try {
        const data = await this.fetchJson<{ vulnerabilities: { cveID: string }[] }>(this.config.intel.kev);
        const ids = data.vulnerabilities.map((v) => v.cveID);
        await this.recordFeed('kev', { fetchedAt: new Date().toISOString(), entries: ids.length, error: null });
        return ids;
      } catch (err) {
        await this.recordFeed('kev', { fetchedAt: new Date().toISOString(), entries: null, error: (err as Error).message });
        throw err;
      }
    });
    return new Set(list);
  }

  /** FIRST EPSS probabilities by CVE. Missing CVEs are simply absent from the result. */
  async epss(cves: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(cves)];
    const out = new Map<string, number>();
    const cached = await this.store.cache.getMany<number | null>(unique.map((c) => `epss:${c}`));
    const todo: string[] = [];
    for (const c of unique) {
      const hit = cached.get(`epss:${c}`);
      if (hit && hit.expiresAt.getTime() > Date.now()) {
        if (hit.value !== null) out.set(c, hit.value);
      } else todo.push(c);
    }
    try {
      for (let i = 0; i < todo.length; i += EPSS_BATCH) {
        const batch = todo.slice(i, i + EPSS_BATCH);
        const res = await this.fetchJson<{ data: { cve: string; epss: string }[] }>(`${this.config.intel.epss}?cve=${batch.join(',')}`);
        const found = new Map(res.data.map((d) => [d.cve, Number(d.epss)]));
        for (const c of batch) {
          const v = found.get(c) ?? null;
          if (v !== null) out.set(c, v);
          await this.store.cache.set(`epss:${c}`, v, DAY);
        }
      }
      if (todo.length) await this.recordFeed('epss', { fetchedAt: new Date().toISOString(), entries: null, error: null });
    } catch (err) {
      await this.recordFeed('epss', { fetchedAt: new Date().toISOString(), entries: null, error: (err as Error).message });
      throw err;
    }
    return out;
  }

  /** Release cycles of a product from endoflife.date, or null if the product is unknown. */
  async eolCycles(product: string): Promise<EolCycle[] | null> {
    try {
      const cycles = await this.cached<EolCycle[]>(`eol:${product}`, DAY, () => this.fetchJson<EolCycle[]>(`${this.config.intel.eol}/api/${encodeURIComponent(product)}.json`));
      await this.recordFeed('eol', { fetchedAt: new Date().toISOString(), entries: null, error: null });
      return cycles;
    } catch (err) {
      if (err instanceof IntelError && err.message.startsWith('404')) return null;
      await this.recordFeed('eol', { fetchedAt: new Date().toISOString(), entries: null, error: (err as Error).message });
      throw err;
    }
  }

  /** Latest stable version and deprecation status of a package version from the public registry. */
  async packageMeta(p: PackageRef): Promise<PackageMeta> {
    return this.cached<PackageMeta>(`pkg:${packageKey(p)}`, DAY, async () => {
      if (p.ecosystem === 'npm') {
        const name = p.name.startsWith('@') ? `@${encodeURIComponent(p.name.slice(1))}` : encodeURIComponent(p.name);
        const [latest, version] = await Promise.all([
          this.fetchJson<{ version: string }>(`${this.config.intel.npmRegistry}/${name}/latest`).catch(() => null),
          this.fetchJson<{ deprecated?: string | boolean }>(`${this.config.intel.npmRegistry}/${name}/${encodeURIComponent(p.version)}`).catch(() => null),
        ]);
        const deprecated = version?.deprecated;
        return { latest: latest?.version ?? null, deprecated: typeof deprecated === 'string' && deprecated ? deprecated : deprecated === true ? 'Deprecated' : null };
      }
      const index = await this.fetchJson<{ versions: string[] }>(`${this.config.intel.nuget}/${encodeURIComponent(p.name.toLowerCase())}/index.json`).catch(() => null);
      return { latest: index ? highestStable('nuget', index.versions) : null, deprecated: null };
    });
  }
}
