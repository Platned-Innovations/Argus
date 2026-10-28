import { opendir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type ScanStatsRecord } from '@argus/data';

/** Files that identify an ecosystem the scanners understand. Matched against the file name. */
const MANIFESTS: [RegExp, string][] = [
  [/^package\.json$/, 'npm'],
  [/^package-lock\.json$/, 'npm'],
  [/^npm-shrinkwrap\.json$/, 'npm'],
  [/^yarn\.lock$/, 'npm'],
  [/^pnpm-lock\.yaml$/, 'npm'],
  [/\.(cs|fs|vb)proj$/i, 'nuget'],
  [/^packages\.config$/i, 'nuget'],
  [/^Directory\.Packages\.props$/i, 'nuget'],
  [/^packages\.lock\.json$/i, 'nuget'],
  [/^global\.json$/i, 'dotnet'],
  [/^\.nvmrc$|^\.node-version$/, 'node'],
  [/^Dockerfile$|\.dockerfile$/i, 'docker'],
  [/\.(pem|crt|cer|der|pfx|p12)$/i, 'certificates'],
];

/** Directories that are vendored or generated; never descended into. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'bower_components', '.yarn', 'bin', 'obj', 'dist', '.next', 'vendor']);
const MAX_FILES = 500_000;
const MAX_MANIFESTS = 1_000;

/**
 * Walks a checked-out repository and records size and which ecosystems are present.
 * Symbolic links are never followed (and are checked out as plain files anyway).
 */
export async function inventory(root: string): Promise<ScanStatsRecord> {
  const stats: ScanStatsRecord = { files: 0, bytes: 0, ecosystems: [], manifests: [] };
  const ecosystems = new Set<string>();
  const stack = [root];
  while (stack.length && stats.files < MAX_FILES) {
    const dir = stack.pop()!;
    const handle = await opendir(dir);
    for await (const entry of handle) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        stats.files++;
        stats.bytes += (await stat(full)).size;
        const match = MANIFESTS.find(([re]) => re.test(entry.name));
        if (match) {
          ecosystems.add(match[1]);
          if (stats.manifests.length < MAX_MANIFESTS) stats.manifests.push(relative(root, full).split(sep).join('/'));
        }
      }
    }
  }
  stats.ecosystems = [...ecosystems].sort();
  stats.manifests.sort();
  return stats;
}
