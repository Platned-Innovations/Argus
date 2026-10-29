import semver from 'semver';
import { type Ecosystem } from '@argus/shared';

/**
 * Normalises a NuGet version (up to four numeric parts, optional prerelease) to an order-preserving semver string.
 * The fourth "revision" part is folded into the patch number, so 1.2.3.4 sorts after 1.2.3 and before 1.2.4.
 * The result is only for comparison, never for display.
 */
function nugetToSemver(v: string): string | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  const [, a, b = '0', c = '0', d = '0', pre = ''] = m;
  const patch = Number(c) * 100_000 + Number(d);
  return `${Number(a)}.${Number(b)}.${patch}${pre}`;
}

function normalize(ecosystem: Ecosystem, v: string): string | null {
  if (ecosystem === 'nuget') return nugetToSemver(v);
  return semver.valid(v.trim(), { loose: true }) ?? semver.valid(semver.coerce(v)?.version ?? '') ?? null;
}

/** -1 / 0 / 1, or null if either version cannot be parsed. */
export function compareVersions(ecosystem: Ecosystem, a: string, b: string): number | null {
  const x = normalize(ecosystem, a);
  const y = normalize(ecosystem, b);
  if (!x || !y) return null;
  return semver.compare(x, y, { loose: true });
}

export function isPrerelease(ecosystem: Ecosystem, v: string): boolean {
  const n = normalize(ecosystem, v);
  return !!n && semver.prerelease(n) !== null;
}

/** The lowest candidate strictly greater than `current` (e.g. the nearest fixed version). */
export function lowestAbove(ecosystem: Ecosystem, current: string, candidates: string[]): string | null {
  let best: string | null = null;
  for (const c of candidates) {
    if ((compareVersions(ecosystem, c, current) ?? -1) <= 0) continue;
    if (best === null || (compareVersions(ecosystem, c, best) ?? 1) < 0) best = c;
  }
  return best;
}

/** Highest stable version from a list (registry metadata). */
export function highestStable(ecosystem: Ecosystem, versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (isPrerelease(ecosystem, v)) continue;
    if (best === null || (compareVersions(ecosystem, v, best) ?? -1) > 0) best = v;
  }
  return best;
}

/** Whether a version satisfies an npm-style range (used for package search filters). */
export function satisfies(ecosystem: Ecosystem, version: string, range: string): boolean {
  const n = normalize(ecosystem, version);
  if (!n) return false;
  if (ecosystem === 'npm') return semver.satisfies(n, range, { loose: true, includePrerelease: true });
  // NuGet versions are normalised, so normalise the bounds in simple comparator ranges too.
  const normalizedRange = range.replace(/(\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?)/g, (m) => nugetToSemver(m) ?? m);
  return semver.satisfies(n, normalizedRange, { loose: true, includePrerelease: true });
}

/** Minimum version satisfying a declared npm range (for manifests without a lockfile). */
export function minVersionOf(range: string): string | null {
  try {
    return semver.minVersion(range)?.version ?? null;
  } catch {
    return null;
  }
}

/** Major version number of a version or range such as "^15.2.0" or ">=18". */
export function majorOf(v: string): number | null {
  const coerced = semver.coerce(v);
  return coerced ? coerced.major : null;
}
