import { dirname, posix } from 'node:path';
import { type Ecosystem, type FindingAdvisory } from '@argus/shared';
import { cvss3BaseScore, scoreForSeverityLabel } from '../cvss';
import { IntelError, type IntelService, mapLimit, type OsvVuln, packageKey } from '../intel.service';
import { parseNuGetLock, parseCentralVersions, parsePackagesConfig, parseProjectFile } from '../parsers/nuget';
import { parsePackageJson, parsePackageJsonDependencies, parsePackageLock, parsePnpmLock, parseYarnLock } from '../parsers/npm';
import { type ParsedDependency } from '../parsers/types';
import { lowestAbove } from '../versions';
import { type DraftFinding, type InventoryItem, type RepoFile, type ScanInput, type Scanner, type ScannerOutput, type SharedScanState } from '../types';

const NPM_LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
/** Registry lookups (latest version, deprecation) are limited to direct dependencies. */
const MAX_REGISTRY_LOOKUPS = 400;

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dir = (p: string) => (p.includes('/') ? posix.dirname(p) : '.');

/** Reads every supported manifest/lockfile into one inventory. Lockfiles win over manifests in the same folder. */
export async function collectDependencies(input: ScanInput): Promise<{ deps: ParsedDependency[]; errors: string[] }> {
  const byDir = new Map<string, Map<string, RepoFile>>();
  for (const f of input.files) {
    const d = dir(f.path);
    if (!byDir.has(d)) byDir.set(d, new Map());
    byDir.get(d)!.set(base(f.path).toLowerCase(), f);
  }
  const deps: ParsedDependency[] = [];
  const errors: string[] = [];
  const read = async (f: RepoFile) => input.readText(f, 50 * 1024 * 1024);
  const attempt = async (f: RepoFile, fn: (text: string) => ParsedDependency[]) => {
    try {
      const text = await read(f);
      if (text) deps.push(...fn(text));
    } catch (err) {
      errors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Central package management versions, nearest Directory.Packages.props up the tree.
  const centralByDir = new Map<string, Map<string, string>>();
  for (const [d, files] of byDir) {
    const props = files.get('directory.packages.props');
    if (props) {
      const text = await read(props);
      if (text) centralByDir.set(d, parseCentralVersions(text));
    }
  }
  const centralFor = (d: string): Map<string, string> => {
    for (let cur = d; ; cur = dir(cur)) {
      const c = centralByDir.get(cur);
      if (c) return c;
      if (cur === '.' || cur === dirname(cur)) return new Map();
    }
  };

  for (const [d, files] of byDir) {
    // npm
    const pkgFile = files.get('package.json');
    const pkg = pkgFile ? parsePackageJson((await read(pkgFile)) ?? '') : null;
    const lock = NPM_LOCKS.map((n) => files.get(n)).find(Boolean);
    if (lock) {
      const name = base(lock.path).toLowerCase();
      await attempt(lock, (t) => (name === 'yarn.lock' ? parseYarnLock(t, lock.path, pkg) : name === 'pnpm-lock.yaml' ? parsePnpmLock(t, lock.path, pkg) : parsePackageLock(t, lock.path, pkg)));
    } else if (pkg && pkgFile) {
      deps.push(...parsePackageJsonDependencies(pkg, pkgFile.path));
    }

    // NuGet: a lock file pins the full graph; otherwise read project files and packages.config.
    const nugetLock = files.get('packages.lock.json');
    if (nugetLock) await attempt(nugetLock, (t) => parseNuGetLock(t, nugetLock.path));
    else {
      for (const f of files.values()) {
        if (/\.(cs|fs|vb)proj$/i.test(f.path)) await attempt(f, (t) => parseProjectFile(t, f.path, centralFor(d)));
      }
    }
    const config = files.get('packages.config');
    if (config) await attempt(config, (t) => parsePackagesConfig(t, config.path));
  }

  // One entry per package version per manifest.
  const unique = new Map<string, ParsedDependency>();
  for (const dep of deps) {
    const key = `${dep.manifestPath}|${packageKey(dep)}`;
    const existing = unique.get(key);
    if (existing) {
      existing.direct ||= dep.direct;
      existing.dev &&= dep.dev;
    } else unique.set(key, { ...dep });
  }
  return { deps: [...unique.values()], errors };
}

function advisoryScore(v: OsvVuln): { score: number | null; vector: string | null } {
  const all = [...(v.severity ?? []), ...(v.affected ?? []).flatMap((a) => a.severity ?? [])];
  for (const s of all) {
    if (s.type === 'CVSS_V3') {
      const score = cvss3BaseScore(s.score);
      if (score !== null) return { score, vector: s.score };
    }
  }
  return { score: scoreForSeverityLabel(v.database_specific?.severity), vector: all.find((s) => s.type.startsWith('CVSS'))?.score ?? null };
}

/** Lowest "fixed" event above the installed version, across the advisory's ranges for this package. */
export function fixedVersionFor(v: OsvVuln, ecosystem: Ecosystem, name: string, version: string): string | null {
  const osvEco = ecosystem === 'npm' ? 'npm' : 'nuget';
  const fixes: string[] = [];
  for (const a of v.affected ?? []) {
    if (a.package?.ecosystem.toLowerCase() !== osvEco) continue;
    if ((ecosystem === 'nuget' ? a.package.name.toLowerCase() : a.package.name) !== (ecosystem === 'nuget' ? name.toLowerCase() : name)) continue;
    for (const r of a.ranges ?? []) for (const e of r.events) if (e.fixed) fixes.push(e.fixed);
  }
  return lowestAbove(ecosystem, version, fixes);
}

function referenceUrl(v: OsvVuln): string | null {
  const advisory = v.references?.find((r) => r.type === 'ADVISORY') ?? v.references?.[0];
  if (v.id.startsWith('GHSA-')) return `https://github.com/advisories/${v.id}`;
  return advisory?.url ?? `https://osv.dev/vulnerability/${v.id}`;
}

export class DependenciesScanner implements Scanner {
  readonly name = 'dependencies' as const;

  constructor(private readonly intel: IntelService) {}

  async run(input: ScanInput, shared: SharedScanState): Promise<ScannerOutput> {
    const { deps, errors } = await collectDependencies(input);
    for (const e of errors) input.log(`Dependencies: could not parse ${e}`);
    const inventory: InventoryItem[] = deps.map((d) => ({ ...d, latestVersion: null, deprecated: null, vulnerabilities: 0 }));
    shared.inventory = inventory;
    input.log(`Dependencies: ${inventory.length} package versions in ${new Set(deps.map((d) => d.manifestPath)).size} manifest(s)`);
    if (!inventory.length) return { status: 'ok', message: 'No npm or NuGet manifests found', findings: [] };

    const problems: string[] = [];
    const findings: DraftFinding[] = [];

    // 1. Known vulnerabilities (OSV.dev, which includes the GitHub Advisory Database).
    let vulnIds = new Map<string, string[]>();
    try {
      vulnIds = await this.intel.queryVulnerabilities(inventory);
    } catch (err) {
      problems.push(`vulnerability lookup failed: ${(err as Error).message}`);
    }
    const allIds = [...new Set([...vulnIds.values()].flat())];
    const vulns = allIds.length ? await this.intel.vulnerabilities(allIds).catch((err: unknown) => (problems.push(`advisory details: ${(err as Error).message}`), new Map<string, OsvVuln>())) : new Map<string, OsvVuln>();
    const cves = [...new Set([...vulns.values()].flatMap((v) => [v.id, ...(v.aliases ?? [])]).filter((id) => id.startsWith('CVE-')))];
    const [kev, epss] = await Promise.all([
      cves.length ? this.intel.kev().catch((err: unknown) => (problems.push(`CISA KEV: ${(err as Error).message}`), new Set<string>())) : Promise.resolve(new Set<string>()),
      cves.length ? this.intel.epss(cves).catch((err: unknown) => (problems.push(`EPSS: ${(err as Error).message}`), new Map<string, number>())) : Promise.resolve(new Map<string, number>()),
    ]);

    for (const dep of inventory) {
      for (const id of vulnIds.get(packageKey(dep)) ?? []) {
        const v = vulns.get(id);
        if (!v || v.withdrawn) continue;
        dep.vulnerabilities++;
        const aliases = (v.aliases ?? []).filter((a) => a !== v.id);
        const cveIds = [v.id, ...aliases].filter((a) => a.startsWith('CVE-'));
        const isKev = cveIds.some((c) => kev.has(c));
        const epssScore = Math.max(0, ...cveIds.map((c) => epss.get(c) ?? 0)) || null;
        const { score, vector } = advisoryScore(v);
        const fixed = fixedVersionFor(v, dep.ecosystem, dep.name, dep.version);
        const advisory: FindingAdvisory = { id: v.id, aliases, summary: v.summary ?? null, cvssScore: score, cvssVector: vector, epss: epssScore, kev: isKev, url: referenceUrl(v), published: v.published ?? null };
        findings.push({
          ruleId: v.id,
          identity: [dep.manifestPath, dep.ecosystem, dep.ecosystem === 'nuget' ? dep.name.toLowerCase() : dep.name],
          title: `${dep.name}@${dep.version}: ${v.summary ?? v.id}`,
          description: v.details ?? v.summary ?? null,
          path: dep.manifestPath,
          line: null,
          package: { ecosystem: dep.ecosystem, name: dep.name, version: dep.version, direct: dep.direct, dev: dep.dev, fixedVersion: fixed },
          advisory,
          secret: null,
          details: dep.unpinned ? { unpinned: true, note: 'Version derived from a range in package.json (no lockfile).' } : null,
          remediation: fixed
            ? `Upgrade ${dep.name} to ${fixed} or later${dep.direct ? '' : ` (it is a transitive dependency: upgrade the package that depends on it, or add an override/resolution)`}.`
            : 'No fixed version is published yet. Consider replacing the package or mitigating as described in the advisory.',
          risk: {
            base: (score ?? 5) * 10,
            baseLabel: score !== null ? `CVSS ${score.toFixed(1)}` : 'Unrated advisory',
            kev: isKev,
            epss: epssScore,
            dev: dep.dev,
            transitive: !dep.direct,
          },
        });
      }
    }

    // 2. Latest version and deprecation for direct dependencies.
    const direct = inventory.filter((d) => d.direct).slice(0, MAX_REGISTRY_LOOKUPS);
    if (!this.intel.offline && direct.length) {
      let registryFailures = 0;
      await mapLimit(direct, 8, async (dep) => {
        try {
          const meta = await this.intel.packageMeta(dep);
          dep.latestVersion = meta.latest;
          dep.deprecated = meta.deprecated;
        } catch (err) {
          if (err instanceof IntelError) registryFailures++;
        }
      });
      if (registryFailures) problems.push(`registry metadata unavailable for ${registryFailures} package(s)`);
      for (const dep of direct) {
        if (!dep.deprecated) continue;
        findings.push({
          ruleId: 'deprecated-package',
          identity: [dep.manifestPath, dep.ecosystem, dep.name],
          title: `${dep.name}@${dep.version} is deprecated`,
          description: dep.deprecated,
          path: dep.manifestPath,
          line: null,
          package: { ecosystem: dep.ecosystem, name: dep.name, version: dep.version, direct: true, dev: dep.dev, fixedVersion: null, latestVersion: dep.latestVersion },
          advisory: null,
          secret: null,
          details: { deprecation: dep.deprecated },
          remediation: `Follow the maintainer's deprecation notice; move to ${dep.latestVersion ? `a supported version (latest ${dep.latestVersion}) or ` : ''}a maintained alternative.`,
          risk: { base: 30, baseLabel: 'Deprecated package', dev: dep.dev },
        });
      }
    }

    // Without vulnerability data the result is incomplete: do not let missing findings count as "fixed".
    const vulnDataMissing = problems.some((p) => p.startsWith('vulnerability lookup') || p.startsWith('advisory details'));
    return { status: vulnDataMissing ? 'partial' : 'ok', message: problems.length ? problems.join('; ') : null, findings };
  }
}
