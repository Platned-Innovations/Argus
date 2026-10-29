import { XMLParser } from 'fast-xml-parser';
import { type ParsedDependency } from './types';

// Repository files are untrusted: parseXml removes any DOCTYPE first, so only XML's predefined entities are decoded
// (no custom entity expansion) and nothing external is ever fetched.
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['ItemGroup', 'PropertyGroup', 'PackageReference', 'PackageVersion', 'package'].includes(name),
});

type XmlNode = Record<string, unknown>;

function parseXml(text: string): XmlNode {
  return xml.parse(text.replace(/<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/gi, '')) as XmlNode;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && '#text' in v) return str((v as XmlNode)['#text']);
  return null;
}

/** "[1.2.3, 2.0)" or "1.2.*" -> lowest concrete version. */
export function lowestNuGetVersion(spec: string): string | null {
  const s = spec.trim().replace(/^[[(]/, '').split(',')[0].trim().replace(/[\])]$/, '');
  if (!s) return null;
  const v = s.replace(/\.\*$/, '.0').replace(/\*$/, '0');
  return /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
}

/** packages.lock.json (NuGet lock file). Project references are skipped. */
export function parseNuGetLock(text: string, manifestPath: string): ParsedDependency[] {
  const doc = JSON.parse(text) as { dependencies?: Record<string, Record<string, { type?: string; resolved?: string }>> };
  const out = new Map<string, ParsedDependency>();
  for (const deps of Object.values(doc.dependencies ?? {})) {
    for (const [name, d] of Object.entries(deps)) {
      if (!d.resolved || d.type === 'Project') continue;
      const key = `${name.toLowerCase()}@${d.resolved}`;
      const direct = d.type === 'Direct';
      const existing = out.get(key);
      if (existing) existing.direct ||= direct;
      else out.set(key, { ecosystem: 'nuget', name, version: d.resolved, direct, dev: false, license: null, manifestPath });
    }
  }
  return [...out.values()];
}

/** Central package management: PackageVersion items from Directory.Packages.props. */
export function parseCentralVersions(text: string): Map<string, string> {
  const doc = parseXml(text);
  const project = (doc.Project ?? {}) as XmlNode;
  const out = new Map<string, string>();
  for (const group of (project.ItemGroup ?? []) as XmlNode[]) {
    for (const pv of (group.PackageVersion ?? []) as XmlNode[]) {
      const name = str(pv['@_Include']);
      const version = str(pv['@_Version']) ?? str(pv.Version);
      if (name && version) out.set(name.toLowerCase(), version);
    }
  }
  return out;
}

/** PackageReference items of an SDK-style project file. */
export function parseProjectFile(text: string, manifestPath: string, central: Map<string, string> = new Map()): ParsedDependency[] {
  const doc = parseXml(text);
  const project = (doc.Project ?? {}) as XmlNode;
  const out: ParsedDependency[] = [];
  for (const group of (project.ItemGroup ?? []) as XmlNode[]) {
    for (const ref of (group.PackageReference ?? []) as XmlNode[]) {
      const name = str(ref['@_Include']);
      if (!name) continue;
      const spec = str(ref['@_VersionOverride']) ?? str(ref['@_Version']) ?? str(ref.Version) ?? central.get(name.toLowerCase()) ?? null;
      const version = spec ? lowestNuGetVersion(spec) : null;
      if (!version) continue;
      // PrivateAssets="all" marks build-time-only packages (analyzers, source generators): not shipped.
      const privateAssets = (str(ref['@_PrivateAssets']) ?? str(ref.PrivateAssets) ?? '').toLowerCase();
      out.push({ ecosystem: 'nuget', name, version, direct: true, dev: privateAssets === 'all', license: null, manifestPath });
    }
  }
  return out;
}

/** Legacy packages.config. */
export function parsePackagesConfig(text: string, manifestPath: string): ParsedDependency[] {
  const doc = parseXml(text);
  const packages = ((doc.packages as XmlNode | undefined)?.package ?? []) as XmlNode[];
  return packages
    .map((p) => ({ name: str(p['@_id']), version: str(p['@_version']), dev: str(p['@_developmentDependency']) === 'true' }))
    .filter((p): p is { name: string; version: string; dev: boolean } => !!p.name && !!p.version)
    .map((p) => ({ ecosystem: 'nuget' as const, name: p.name, version: p.version, direct: true, dev: p.dev, license: null, manifestPath }));
}

/** TargetFramework / TargetFrameworks of a project file, e.g. ["net6.0", "net48"]. */
export function projectTargetFrameworks(text: string): string[] {
  const doc = parseXml(text);
  const project = (doc.Project ?? {}) as XmlNode;
  const out = new Set<string>();
  for (const group of (project.PropertyGroup ?? []) as XmlNode[]) {
    for (const key of ['TargetFramework', 'TargetFrameworks', 'TargetFrameworkVersion']) {
      const v = str(group[key]);
      if (!v) continue;
      for (const tfm of v.split(';')) {
        const t = tfm.trim();
        // Old-style projects say "v4.7.2".
        if (t) out.add(key === 'TargetFrameworkVersion' ? `net${t.replace(/^v/, '').replace(/\./g, '')}` : t);
      }
    }
  }
  return [...out];
}

/** Well-known license URLs used by older packages (before license expressions). */
const LICENSE_URLS: [RegExp, string][] = [
  [/^https?:\/\/licenses\.nuget\.org\/(.+)$/i, '$1'],
  [/opensource\.org\/licenses\/mit/i, 'MIT'],
  [/apache\.org\/licenses\/LICENSE-2\.0/i, 'Apache-2.0'],
  [/opensource\.org\/licenses\/BSD-3-Clause/i, 'BSD-3-Clause'],
  [/opensource\.org\/licenses\/BSD-2-Clause/i, 'BSD-2-Clause'],
  [/gnu\.org\/licenses\/gpl-3\.0/i, 'GPL-3.0-only'],
  [/gnu\.org\/licenses\/lgpl/i, 'LGPL-3.0-only'],
];

/** SPDX license expression from a .nuspec, or null when the package only ships a license file or none. */
export function nuspecLicense(text: string): string | null {
  // The shared parser reads <package> as a list (packages.config has many).
  const root = parseXml(text).package as XmlNode | XmlNode[] | undefined;
  const metadata = (Array.isArray(root) ? root[0] : root)?.metadata as XmlNode | undefined;
  if (!metadata) return null;
  const license = metadata.license as XmlNode | string | undefined;
  if (license && typeof license === 'object') {
    if (license['@_type'] === 'expression') return str(license['#text']);
    return null;
  }
  if (typeof license === 'string' && license.trim()) return license.trim();
  const url = str(metadata.licenseUrl);
  if (!url) return null;
  for (const [re, id] of LICENSE_URLS) {
    const m = re.exec(url);
    if (m) return decodeURIComponent(id.replace('$1', m[1] ?? ''));
  }
  return null;
}
