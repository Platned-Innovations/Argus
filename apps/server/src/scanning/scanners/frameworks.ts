import { type EolCycle, type IntelService } from '../intel.service';
import { parsePackageJson } from '../parsers/npm';
import { projectTargetFrameworks } from '../parsers/nuget';
import semver from 'semver';
import { majorOf } from '../versions';
import { type DraftFinding, type RepoFile, type ScanInput, type Scanner, type ScannerOutput } from '../types';

/** A framework/runtime version in use, mapped to an endoflife.date product and release cycle. */
export interface FrameworkUsage {
  product: string;
  label: string;
  cycle: string;
  path: string;
  evidence: string;
}

const DAY = 86_400_000;
const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** "net6.0" -> .NET 6.0, "netcoreapp3.1" -> .NET Core 3.1, "net48" / "net472" -> .NET Framework 4.8 / 4.7.2. */
export function mapTargetFramework(tfm: string): { product: string; label: string; cycle: string } | null {
  const t = tfm.toLowerCase().replace(/-.*$/, '');
  let m = /^net(\d+)\.(\d+)$/.exec(t);
  if (m && Number(m[1]) >= 5) return { product: 'dotnet', label: '.NET', cycle: `${m[1]}.${m[2]}` };
  m = /^netcoreapp(\d+)\.(\d+)$/.exec(t);
  if (m) return { product: 'dotnet', label: '.NET Core', cycle: `${m[1]}.${m[2]}` };
  m = /^net(\d)(\d)(\d)?$/.exec(t);
  if (m) return { product: 'dotnetfx', label: '.NET Framework', cycle: [m[1], m[2], m[3]].filter(Boolean).join('.') };
  return null;
}

const JS_FRAMEWORKS: [string, string, string][] = [
  ['@angular/core', 'angular', 'Angular'],
  ['react', 'react', 'React'],
  ['vue', 'vue', 'Vue'],
  ['next', 'nextjs', 'Next.js'],
];

export async function detectFrameworks(input: ScanInput): Promise<FrameworkUsage[]> {
  const out: FrameworkUsage[] = [];
  const read = (f: RepoFile) => input.readText(f, 2 * 1024 * 1024);
  for (const f of input.files) {
    const n = name(f.path);
    try {
      if (/\.(cs|fs|vb)proj$/i.test(n)) {
        const text = await read(f);
        for (const tfm of text ? projectTargetFrameworks(text) : []) {
          const m = mapTargetFramework(tfm);
          if (m) out.push({ ...m, path: f.path, evidence: `TargetFramework ${tfm}` });
        }
      } else if (n === 'global.json') {
        const sdk = (JSON.parse((await read(f)) ?? '{}') as { sdk?: { version?: string } }).sdk?.version;
        const m = sdk ? /^(\d+)\.(\d+)/.exec(sdk) : null;
        if (m) out.push({ product: 'dotnet', label: '.NET SDK', cycle: `${m[1]}.${m[2]}`, path: f.path, evidence: `SDK ${sdk}` });
      } else if (n === '.nvmrc' || n === '.node-version') {
        const v = ((await read(f)) ?? '').trim();
        const major = /^v?\d/.test(v) ? majorOf(v) : null;
        if (major) out.push({ product: 'nodejs', label: 'Node.js', cycle: String(major), path: f.path, evidence: `Node ${v}` });
      } else if (n === 'package.json') {
        const pkg = parsePackageJson((await read(f)) ?? '');
        const engine = pkg?.engines?.node;
        const engineMajor = engine ? majorOf(engine) : null;
        if (engine && engineMajor) out.push({ product: 'nodejs', label: 'Node.js', cycle: String(engineMajor), path: f.path, evidence: `engines.node "${engine}"` });
        const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
        for (const [dep, product, label] of JS_FRAMEWORKS) {
          const range = deps[dep];
          const v = range && /\d/.test(range) && !/^(workspace|file|link|git|https?):/.test(range) ? semver.coerce(range) : null;
          // major.minor: some products (e.g. Vue) have minor-level release cycles; matching falls back to the major.
          if (v) out.push({ product, label, cycle: `${v.major}.${v.minor}`, path: f.path, evidence: `${dep} "${range}"` });
        }
      } else if (n === 'Dockerfile' || n.toLowerCase().endsWith('.dockerfile')) {
        for (const line of ((await read(f)) ?? '').split(/\r?\n/)) {
          const image = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line)?.[1];
          if (!image) continue;
          let m = /(?:^|\/)node:(\d+)/.exec(image);
          if (m) out.push({ product: 'nodejs', label: 'Node.js', cycle: m[1], path: f.path, evidence: `FROM ${image}` });
          m = /mcr\.microsoft\.com\/dotnet\/(?:core\/)?(?:aspnet|runtime|sdk|runtime-deps):(\d+)\.(\d+)/.exec(image);
          if (m) out.push({ product: 'dotnet', label: '.NET', cycle: `${m[1]}.${m[2]}`, path: f.path, evidence: `FROM ${image}` });
        }
      }
    } catch {
      // Malformed files are reported by the dependency scanner; here they are simply skipped.
    }
  }
  return out;
}

/**
 * endoflife.date names cycles inconsistently ("6" for .NET 6, "3.1" for .NET Core 3.1, "3.5" for Vue 3.5),
 * so try the exact version, then without a trailing ".0", then major.minor, then major.
 */
export function matchCycle(cycles: EolCycle[], version: string): EolCycle | null {
  const parts = version.split('.');
  const candidates = [version, version.replace(/\.0$/, ''), parts.slice(0, 2).join('.'), parts[0]];
  for (const c of candidates) {
    const hit = cycles.find((x) => String(x.cycle) === c);
    if (hit) return hit;
  }
  return null;
}

function eolDate(c: EolCycle): Date | 'yes' | null {
  if (c.eol === true) return 'yes';
  if (typeof c.eol === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c.eol)) return new Date(`${c.eol.slice(0, 10)}T00:00:00Z`);
  return null;
}

/** Newest cycle that is still supported (preferring LTS), to suggest as an upgrade target. */
function suggestedCycle(cycles: EolCycle[], now: number): EolCycle | null {
  const supported = cycles.filter((c) => {
    const d = eolDate(c);
    return d === null || (d !== 'yes' && d.getTime() > now);
  });
  return supported.find((c) => !!c.lts) ?? supported[0] ?? null;
}

export class FrameworksScanner implements Scanner {
  readonly name = 'frameworks' as const;

  constructor(private readonly intel: IntelService) {}

  async run(input: ScanInput): Promise<ScannerOutput> {
    const usages = await detectFrameworks(input);
    if (!usages.length) return { status: 'ok', message: 'No supported frameworks detected', findings: [] };
    input.log(`Frameworks: ${usages.map((u) => `${u.label} ${u.cycle}`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`);

    const products = [...new Set(usages.map((u) => u.product))];
    const cycles = new Map<string, EolCycle[] | null>();
    const problems: string[] = [];
    for (const p of products) {
      try {
        cycles.set(p, await this.intel.eolCycles(p));
      } catch (err) {
        problems.push(`${p}: ${(err as Error).message}`);
      }
    }

    const now = Date.now();
    const warnMs = input.settings.eolWarningDays * DAY;
    const findings: DraftFinding[] = [];
    for (const u of usages) {
      const list = cycles.get(u.product);
      const cycle = list ? matchCycle(list, u.cycle) : null;
      if (!list || !cycle) continue;
      const cycleName = String(cycle.cycle);
      const eol = eolDate(cycle);
      if (!eol) continue;
      const past = eol === 'yes' || eol.getTime() <= now;
      if (!past && (eol as Date).getTime() - now > warnMs) continue;
      const when = eol === 'yes' ? null : eol.toISOString().slice(0, 10);
      const daysLeft = eol === 'yes' ? null : Math.ceil(((eol as Date).getTime() - now) / DAY);
      const target = suggestedCycle(list, now);
      findings.push({
        ruleId: past ? 'framework-eol' : 'framework-eol-soon',
        identity: [u.product, cycleName, u.path],
        title: past ? `${u.label} ${cycleName} is end of life${when ? ` (since ${when})` : ''}` : `${u.label} ${cycleName} reaches end of life on ${when}`,
        description: `${u.evidence} in ${u.path}. ${past ? 'It no longer receives security fixes.' : `Security fixes stop in ${daysLeft} day(s).`}`,
        path: u.path,
        line: null,
        package: null,
        advisory: null,
        secret: null,
        details: { product: u.product, cycle: cycleName, eol: when, latestPatch: cycle.latest ?? null, suggested: target ? String(target.cycle) : null, evidence: u.evidence },
        remediation: target ? `Upgrade to ${u.label} ${target.cycle}${target.lts ? ' (LTS)' : ''}, which is supported.` : `Upgrade to a supported ${u.label} release.`,
        risk: past
          ? { base: 70, baseLabel: 'Unsupported (end of life)' }
          : { base: daysLeft !== null && daysLeft <= 90 ? 50 : 35, baseLabel: `End of life in ${daysLeft} day(s)` },
      });
    }
    return { status: problems.length ? 'partial' : 'ok', message: problems.length ? problems.join('; ') : null, findings };
  }
}
