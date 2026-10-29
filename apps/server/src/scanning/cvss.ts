/**
 * CVSS v3.0 / v3.1 base score from a vector string (FIRST specification, section 7).
 * Returns null for anything that is not a complete v3 vector.
 */
const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

function roundUp(x: number): number {
  // Spec-defined rounding that avoids floating point artefacts.
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
}

export function cvss3BaseScore(vector: string): number | null {
  const parts = vector.trim().split('/');
  if (!/^CVSS:3\.[01]$/.test(parts[0] ?? '')) return null;
  const m = new Map(parts.slice(1).map((p) => p.split(':') as [string, string]));
  const av = W.AV[m.get('AV') as keyof typeof W.AV];
  const ac = W.AC[m.get('AC') as keyof typeof W.AC];
  const ui = W.UI[m.get('UI') as keyof typeof W.UI];
  const scope = m.get('S');
  const pr = m.get('PR');
  const c = W.CIA[m.get('C') as keyof typeof W.CIA];
  const i = W.CIA[m.get('I') as keyof typeof W.CIA];
  const a = W.CIA[m.get('A') as keyof typeof W.CIA];
  if ([av, ac, ui, c, i, a].some((x) => x === undefined) || (scope !== 'U' && scope !== 'C') || !['N', 'L', 'H'].includes(pr ?? '')) return null;
  const changed = scope === 'C';
  const prW = pr === 'N' ? 0.85 : pr === 'L' ? (changed ? 0.68 : 0.62) : changed ? 0.5 : 0.27;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploitability = 8.22 * av * ac * prW * ui;
  if (impact <= 0) return 0;
  return changed ? roundUp(Math.min(1.08 * (impact + exploitability), 10)) : roundUp(Math.min(impact + exploitability, 10));
}

/** Approximate score for advisories that only carry a qualitative severity (e.g. GitHub "MODERATE"). */
export function scoreForSeverityLabel(label: string | null | undefined): number | null {
  switch ((label ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 9.5;
    case 'HIGH':
      return 7.5;
    case 'MODERATE':
    case 'MEDIUM':
      return 5.0;
    case 'LOW':
      return 2.5;
    default:
      return null;
  }
}
