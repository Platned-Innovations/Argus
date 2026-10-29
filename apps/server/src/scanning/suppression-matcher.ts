import { createHash } from 'node:crypto';
import { type Suppression } from '@argus/data';
import { type ScannerName } from '@argus/shared';
import { globToRegExp } from './glob';
import { groupKeyFor } from './group-key';
import { type RepoScanConfig } from './repo-config';
import { type DraftFinding } from './types';

export interface SuppressionRule {
  id: string;
  source: 'argus' | 'repo-file';
  scanner: ScannerName | null;
  ruleId: string | null;
  pathPattern: string | null;
  packageName: string | null;
  /** Set for suppressions created from a ticket: only that ticket's issue matches. */
  groupKey: string | null;
  reason: string;
}

/** Deterministic UUID-shaped id for `.argus.yml` entries, so a finding keeps pointing at "the same" rule across scans. */
function fileRuleId(repoId: string, index: number, entry: unknown): string {
  const h = createHash('sha256').update(`${repoId}|${index}|${JSON.stringify(entry)}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function buildSuppressionRules(repoId: string, stored: Suppression[], file: RepoScanConfig, now: Date): SuppressionRule[] {
  const fromDb: SuppressionRule[] = stored.map((s) => ({
    id: s.id,
    source: 'argus',
    scanner: s.scanner,
    ruleId: s.ruleId,
    pathPattern: s.pathPattern,
    packageName: s.packageName,
    groupKey: s.groupKey,
    reason: s.reason,
  }));
  const fromFile: SuppressionRule[] = file.suppress
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.expires || s.expires > now)
    .map(({ s, i }) => ({
      id: fileRuleId(repoId, i, s),
      source: 'repo-file' as const,
      scanner: s.scanner ?? null,
      ruleId: s.rule ?? null,
      pathPattern: s.path ?? null,
      packageName: s.package ?? null,
      groupKey: null,
      reason: s.reason,
    }));
  return [...fromDb, ...fromFile];
}

/** Every field a rule sets must match; unset fields match anything. A rule id also matches advisory aliases (CVE ids). */
export function matchSuppression(rules: SuppressionRule[], scanner: ScannerName, d: DraftFinding): SuppressionRule | null {
  for (const r of rules) {
    if (r.scanner && r.scanner !== scanner) continue;
    if (r.ruleId) {
      const ids = [d.ruleId, ...(d.advisory?.aliases ?? [])].map((x) => x.toLowerCase());
      if (!ids.includes(r.ruleId.toLowerCase())) continue;
    }
    if (r.pathPattern && !(d.path && globToRegExp(r.pathPattern).test(d.path))) continue;
    if (r.packageName && d.package?.name.toLowerCase() !== r.packageName.toLowerCase()) continue;
    if (r.groupKey && groupKeyFor({ ...d, scanner }) !== r.groupKey) continue;
    return r;
  }
  return null;
}
