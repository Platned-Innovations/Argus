import { type Criticality, type RiskFactor, type RiskWeights, type Severity, severityForScore } from '@argus/shared';

/** Facts about a finding and its repository that move the risk score. */
export interface RiskInput {
  /** Starting score (0-100) from the nature of the issue, e.g. CVSS x 10 or the secret type. */
  base: number;
  baseLabel: string;
  kev?: boolean;
  /** EPSS probability (0-1). */
  epss?: number | null;
  dev?: boolean;
  transitive?: boolean;
  testPath?: boolean;
  /** Result of live verification with the secret's issuer. */
  verified?: 'active' | 'inactive';
  publicRepo: boolean;
  criticality: Criticality;
}

export interface RiskResult {
  score: number;
  severity: Severity;
  factors: RiskFactor[];
}

/**
 * Transparent additive model: every adjustment is recorded as a factor so the UI can explain the score.
 * Weights come from the scanning settings; the result is clamped to 0-100.
 */
export function computeRisk(input: RiskInput, w: RiskWeights): RiskResult {
  const factors: RiskFactor[] = [{ key: 'base', label: input.baseLabel, points: Math.round(input.base) }];
  const add = (key: string, label: string, points: number) => {
    if (points !== 0) factors.push({ key, label, points: Math.round(points) });
  };
  if (input.kev) add('kev', 'Known exploited in the wild (CISA KEV)', w.kev);
  if (input.epss && input.epss > 0) add('epss', `Exploit probability ${(input.epss * 100).toFixed(1)}% (EPSS)`, input.epss * w.epssMax);
  if (input.dev) add('dev_dependency', 'Development-only dependency', w.devDependency);
  else if (input.transitive) add('transitive_dependency', 'Transitive dependency', w.transitiveDependency);
  if (input.testPath) add('test_path', 'Located in test or example code', w.testPath);
  if (input.verified === 'active') add('verified_active', 'Verified active with its issuer', w.verifiedActive);
  if (input.verified === 'inactive') add('verified_inactive', 'Rejected by its issuer (revoked or invalid)', w.verifiedInactive);
  if (input.publicRepo) add('public_repo', 'Repository is public', w.publicRepo);
  if (input.criticality === 'low') add('criticality', 'Low business criticality', w.criticalityLow);
  if (input.criticality === 'high') add('criticality', 'High business criticality', w.criticalityHigh);
  if (input.criticality === 'critical') add('criticality', 'Critical business criticality', w.criticalityCritical);
  const score = Math.max(0, Math.min(100, factors.reduce((s, f) => s + f.points, 0)));
  return { score, severity: severityForScore(score), factors };
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|examples?|samples?|mocks?|testdata|test-data|demo)(\/|$)|\.(test|spec|stories)\.[a-z0-9]+$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}
