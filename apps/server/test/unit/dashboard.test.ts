import { type FindingStatRow, type TicketStatRow } from '@argus/data';
import { describe, expect, it } from 'vitest';
import { buildDashboard } from '../../src/reports/dashboard';
import { dashboardPdf, pdfString } from '../../src/reports/pdf';

const DAY = 86_400_000;
const now = new Date('2026-10-29T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

const f = (over: Partial<FindingStatRow>): FindingStatRow => ({
  repoId: 'r1',
  scanner: 'dependencies',
  severity: 'high',
  riskScore: 70,
  status: 'open',
  firstSeenAt: ago(10),
  fixedAt: null,
  title: 'x',
  details: null,
  ...over,
});

describe('dashboard', () => {
  const findings: FindingStatRow[] = [
    f({ severity: 'critical', riskScore: 95, firstSeenAt: ago(20) }),
    f({ severity: 'high', firstSeenAt: ago(5) }),
    // Fixed 2 days ago after 8 days open.
    f({ severity: 'high', status: 'fixed', firstSeenAt: ago(10), fixedAt: ago(2) }),
    // Fixed long before the period: ignored for MTTR.
    f({ severity: 'critical', status: 'fixed', firstSeenAt: ago(300), fixedAt: ago(200) }),
    f({ severity: 'low', status: 'suppressed', firstSeenAt: ago(3) }),
    f({ repoId: 'r2', scanner: 'certificates', severity: 'medium', riskScore: 40, details: { validTo: new Date(now.getTime() + 20 * DAY).toISOString() }, title: 'Certificate expires in 20 day(s)' }),
    f({ repoId: 'r2', scanner: 'frameworks', severity: 'high', details: { product: 'dotnet', cycle: '6', eol: '2024-11-12' } }),
    f({ repoId: 'r1', scanner: 'frameworks', severity: 'high', details: { product: 'dotnet', cycle: '6', eol: '2024-11-12' } }),
  ];
  const tickets: TicketStatRow[] = [
    { severity: 'high', status: 'resolved', createdAt: ago(10), dueAt: ago(1), resolvedAt: ago(2) },
    { severity: 'high', status: 'resolved', createdAt: ago(40), dueAt: ago(10), resolvedAt: ago(5) },
    { severity: 'critical', status: 'open', createdAt: ago(20), dueAt: ago(13), resolvedAt: null },
    { severity: 'low', status: 'open', createdAt: ago(1), dueAt: ago(-100), resolvedAt: null },
  ];
  const d = buildDashboard(findings, tickets, new Map([['r1', 'acme/api'], ['r2', 'acme/web']]), { days: 30, now, teamId: null, repoId: null });

  it('counts open, suppressed and per-scanner findings', () => {
    expect(d.open).toEqual({ critical: 1, high: 3, medium: 1, low: 0, info: 0 });
    expect(d.openTotal).toBe(5);
    expect(d.suppressed).toBe(1);
    expect(d.byScanner).toMatchObject({ dependencies: 2, certificates: 1, frameworks: 2 });
  });

  it('reconstructs daily open counts from first-seen and fixed dates', () => {
    expect(d.trend).toHaveLength(30);
    expect(d.trend.at(-1)).toMatchObject({ date: '2026-10-29', total: 5 });
    // 6 days ago: the critical, the later-fixed high, and the three findings first seen 10 days ago.
    const sixDaysAgo = d.trend.find((p) => p.date === '2026-10-23')!;
    expect(sixDaysAgo.total).toBe(5);
    expect(sixDaysAgo.bySeverity.high).toBe(3);
    // 25 days ago only the critical existed.
    expect(d.trend.find((p) => p.date === '2026-10-04')!.total).toBe(0);
    expect(d.trend.find((p) => p.date === '2026-10-09')!.bySeverity.critical).toBe(1);
  });

  it('computes weekly opened/fixed, MTTR and SLA compliance', () => {
    expect(d.newVsFixed.reduce((n, w) => n + w.fixed, 0)).toBe(1);
    expect(d.newVsFixed.every((w) => new Date(`${w.week}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect(d.mttrDays).toMatchObject({ high: 8, critical: null });
    expect(d.sla).toEqual({ resolved: 2, onTime: 1, compliancePct: 50, active: 2, breached: 1 });
  });

  it('ranks repositories, lists expiring certificates and EOL exposure', () => {
    expect(d.topRepos[0]).toMatchObject({ repoId: 'r1', fullName: 'acme/api', critical: 1, openFindings: 3 });
    expect(d.expiring).toEqual([expect.objectContaining({ kind: 'certificate', daysLeft: 20, location: 'acme/web' })]);
    expect(d.eol).toEqual([{ product: 'dotnet', cycle: '6', eol: '2024-11-12', repos: 2 }]);
  });

  it('merges tracked credentials into the expiry timeline, soonest first', () => {
    const withCreds = buildDashboard(findings, tickets, new Map(), {
      days: 30,
      now,
      teamId: null,
      repoId: null,
      credentials: [{ kind: 'credential', title: 'Payments API key', repoId: null, location: 'Stripe', expiresAt: ago(-5).toISOString(), daysLeft: 5 }],
    });
    expect(withCreds.expiring.map((e) => e.kind)).toEqual(['credential', 'certificate']);
  });
});

describe('PDF report', () => {
  const now = new Date('2026-06-30T12:00:00Z');
  const d = buildDashboard([], [], new Map(), { days: 30, now, teamId: null, repoId: null });
  d.topRepos = [{ repoId: 'r', fullName: 'acme/(api) \\ “quoted” — 日本', openFindings: 3, critical: 1, high: 2, riskTotal: 210 }];

  it('escapes text and maps characters outside WinAnsi', () => {
    expect(pdfString('a(b)c\\d')).toBe('a\\(b\\)c\\\\d');
    expect(pdfString('“x” — é 日\n')).toBe('"x" - é ? ');
  });

  it('writes a well-formed PDF whose cross-reference offsets point at their objects', () => {
    const pdf = dashboardPdf(d, { product: 'Contoso', scope: 'Whole organisation', periodLabel: 'Last 30 days' });
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = text.slice(startxref).split('\n').slice(3).filter((l) => / 00000 n $/.test(l));
    entries.forEach((e, i) => expect(text.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + 12)).toMatch(new RegExp(`^${i + 1} 0 obj\n`)));
    expect(text).toContain('(Security report) Tj');
    expect(text).toContain('/Title (Contoso - Security report)');
    expect(text).toContain('acme/\\(api\\) \\\\ "quoted" - ??');
  });
});
