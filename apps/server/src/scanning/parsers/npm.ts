import { parse as parseYaml } from 'yaml';
import { minVersionOf } from '../versions';
import { type ParsedDependency } from './types';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

export function parsePackageJson(text: string): PackageJson | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as PackageJson) : null;
  } catch {
    return null;
  }
}

function rootSets(pkg: PackageJson | null) {
  const prod = new Set([...Object.keys(pkg?.dependencies ?? {}), ...Object.keys(pkg?.optionalDependencies ?? {}), ...Object.keys(pkg?.peerDependencies ?? {})]);
  const dev = new Set(Object.keys(pkg?.devDependencies ?? {}));
  return { prod, dev, all: new Set([...prod, ...dev]) };
}

function licenseOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') return (v as { type: string }).type;
  return null;
}

interface LockEntry {
  name?: string;
  version?: string;
  dev?: boolean;
  link?: boolean;
  license?: unknown;
  dependencies?: Record<string, LockEntry>;
}

/** package-lock.json / npm-shrinkwrap.json, lockfile versions 1, 2 and 3. */
export function parsePackageLock(text: string, manifestPath: string, pkg: PackageJson | null): ParsedDependency[] {
  const lock = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, LockEntry & { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>; dependencies?: Record<string, LockEntry> };
  const roots = rootSets(pkg ?? ((lock.packages?.[''] as PackageJson | undefined) ?? null));
  const out: ParsedDependency[] = [];

  if (lock.packages && (lock.lockfileVersion ?? 1) >= 2) {
    for (const [key, entry] of Object.entries(lock.packages)) {
      const idx = key.lastIndexOf('node_modules/');
      // Skip the root project, workspace folders and symlinked workspace packages.
      if (!key || idx === -1 || entry.link || !entry.version) continue;
      const name = entry.name ?? key.slice(idx + 'node_modules/'.length);
      const topLevel = key === `node_modules/${name}`;
      out.push({ ecosystem: 'npm', name, version: entry.version, direct: topLevel && roots.all.has(name), dev: entry.dev === true, license: licenseOf(entry.license), manifestPath });
    }
    return out;
  }

  const walk = (deps: Record<string, LockEntry> | undefined, depth: number) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      if (entry.version && !/^(file|link|git|github|https?):/.test(entry.version)) {
        out.push({ ecosystem: 'npm', name, version: entry.version, direct: depth === 0 && roots.all.has(name), dev: entry.dev === true, license: null, manifestPath });
      }
      walk(entry.dependencies, depth + 1);
    }
  };
  walk(lock.dependencies, 0);
  return out;
}

/** Splits "name@range" (scoped names start with "@"). */
function splitSpec(spec: string): { name: string; range: string } | null {
  const s = spec.trim().replace(/^"|"$/g, '');
  const at = s.indexOf('@', 1);
  if (at <= 0) return null;
  return { name: s.slice(0, at), range: s.slice(at + 1) };
}

/** yarn.lock: classic (v1) text format and Berry (v2+) YAML format. */
export function parseYarnLock(text: string, manifestPath: string, pkg: PackageJson | null): ParsedDependency[] {
  const roots = rootSets(pkg);
  const out: ParsedDependency[] = [];
  const push = (name: string, version: string) => out.push({ ecosystem: 'npm', name, version, direct: roots.all.has(name), dev: roots.dev.has(name) && !roots.prod.has(name), license: null, manifestPath });

  if (/^__metadata:/m.test(text)) {
    const doc = (parseYaml(text, { maxAliasCount: 100 }) ?? {}) as Record<string, { version?: string | number }>;
    for (const [key, entry] of Object.entries(doc)) {
      if (key === '__metadata' || !entry?.version) continue;
      const spec = splitSpec(key.split(',')[0]);
      if (!spec || /^(workspace|link|portal|file|patch):/.test(spec.range)) continue;
      push(spec.name, String(entry.version));
    }
    return out;
  }

  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith(' ') && line.endsWith(':')) {
      current = splitSpec(line.slice(0, -1).split(/,\s*/)[0])?.name ?? null;
    } else if (current) {
      const m = /^\s+version\s+"?([^"\s]+)"?/.exec(line);
      if (m) {
        push(current, m[1]);
        current = null;
      }
    }
  }
  return out;
}

/** pnpm-lock.yaml, lockfile versions 5.x, 6.x and 9.x. */
export function parsePnpmLock(text: string, manifestPath: string, pkg: PackageJson | null): ParsedDependency[] {
  const doc = (parseYaml(text, { maxAliasCount: 100 }) ?? {}) as {
    importers?: Record<string, { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    packages?: Record<string, { dev?: boolean; resolution?: unknown; license?: string; name?: string; version?: string }>;
    snapshots?: Record<string, unknown>;
  };
  const rootImporter = doc.importers?.['.'] ?? { dependencies: doc.dependencies, devDependencies: doc.devDependencies };
  const devRoots = new Set(Object.keys(rootImporter.devDependencies ?? {}));
  const prodRoots = new Set(Object.keys(rootImporter.dependencies ?? {}));
  for (const k of Object.keys(pkg?.devDependencies ?? {})) devRoots.add(k);
  for (const k of Object.keys(pkg?.dependencies ?? {})) prodRoots.add(k);

  const out: ParsedDependency[] = [];
  const seen = new Set<string>();
  for (const [rawKey, entry] of Object.entries(doc.packages ?? {})) {
    // "/lodash/4.17.21" (v5), "/lodash@4.17.21" (v6), "lodash@4.17.21" (v9); strip peer-dependency suffixes.
    const key = rawKey.replace(/^\//, '').replace(/\(.*$/, '');
    const m = /^(@[^/]+\/[^@/]+|[^@/]+)[@/]([^/_]+)/.exec(key);
    const name = entry?.name ?? m?.[1];
    const version = entry?.version ?? m?.[2];
    if (!name || !version || !/^\d/.test(version)) continue;
    if (seen.has(`${name}@${version}`)) continue;
    seen.add(`${name}@${version}`);
    const direct = prodRoots.has(name) || devRoots.has(name);
    const dev = entry?.dev === true || (direct && devRoots.has(name) && !prodRoots.has(name));
    out.push({ ecosystem: 'npm', name, version, direct, dev, license: entry?.license ?? null, manifestPath });
  }
  return out;
}

/**
 * A package.json without a lockfile: exact versions are unknown, so the lowest version allowed by each range
 * is used. Non-registry specifiers (git, file, workspace, URLs, tags) are skipped.
 */
export function parsePackageJsonDependencies(pkg: PackageJson, manifestPath: string): ParsedDependency[] {
  const out: ParsedDependency[] = [];
  const add = (deps: Record<string, string> | undefined, dev: boolean) => {
    for (const [name, range] of Object.entries(deps ?? {})) {
      if (/^(workspace|file|link|git|github|https?|npm):|\//.test(range)) continue;
      const version = minVersionOf(range);
      if (version) out.push({ ecosystem: 'npm', name, version, direct: true, dev, license: null, manifestPath, unpinned: true });
    }
  };
  add(pkg.dependencies, false);
  add(pkg.optionalDependencies, false);
  add(pkg.devDependencies, true);
  return out;
}
