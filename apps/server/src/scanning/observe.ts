import { createHash } from 'node:crypto';
import { type ObservedFinding, type Repository } from '@argus/data';
import { type RiskWeights, type ScannerName } from '@argus/shared';
import { computeRisk } from './risk';
import { matchSuppression, type SuppressionRule } from './suppression-matcher';
import { type DraftFinding } from './types';

/** Stable identity of an issue in a repository (never includes line numbers). */
export function fingerprintOf(scanner: ScannerName, d: Pick<DraftFinding, 'ruleId' | 'identity'>): string {
  return createHash('sha256').update([scanner, d.ruleId, ...d.identity].join('\u0000')).digest('hex').slice(0, 40);
}

/** Scores a scanner result, applies suppressions and computes its fingerprint. Used by scans and continuous re-matching. */
export function toObservedFinding(repo: Repository, scanner: ScannerName, d: DraftFinding, weights: RiskWeights, rules: SuppressionRule[]): ObservedFinding {
  const risk = computeRisk({ ...d.risk, publicRepo: repo.visibility === 'public', criticality: repo.criticality }, weights);
  const suppression = matchSuppression(rules, scanner, d);
  return {
    scanner,
    ruleId: d.ruleId,
    fingerprint: fingerprintOf(scanner, d),
    title: d.title.slice(0, 500),
    description: d.description?.slice(0, 4000) ?? null,
    severity: risk.severity,
    riskScore: risk.score,
    riskFactors: risk.factors,
    path: d.path,
    line: d.line,
    package: d.package,
    advisory: d.advisory,
    secret: d.secret,
    details: suppression ? { ...(d.details ?? {}), suppression: { source: suppression.source, reason: suppression.reason } } : d.details,
    remediation: d.remediation,
    suppressionId: suppression?.id ?? null,
  };
}
