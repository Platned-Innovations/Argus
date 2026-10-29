import { type FindingStatRow, type TicketStatRow } from '@argus/data';
import {
  type DashboardDto,
  type EolExposureDto,
  type ExpiringItemDto,
  type NewVsFixedPoint,
  type RiskyRepoDto,
  SCANNERS,
  type ScannerName,
  type Severity,
  SEVERITIES,
  type TrendPoint,
} from '@argus/shared';

const DAY = 86_400_000;
const EXPIRY_HORIZON_DAYS = 180;
const ACTIVE_TICKETS = new Set(['open', 'triaged', 'in_progress', 'reopened']);

const zero = <T extends string>(keys: readonly T[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
function mondayOf(d: Date): Date {
  const day = startOfUtcDay(d);
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
}

/** Expiry date of a certificate or token finding (certificates use validTo, JWTs expiresAt). */
function expiryOf(f: FindingStatRow): Date | null {
  const v = f.details?.validTo ?? f.details?.expiresAt;
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Turns finding and ticket rows into dashboard figures. Pure, so it is unit-tested directly.
 * History is reconstructed from first-seen and fixed dates: a finding counts as open on a day when it had been seen
 * and was not yet fixed. Suppressed findings are left out of the trend (their suppression date is not kept).
 */
export function buildDashboard(
  findings: FindingStatRow[],
  tickets: TicketStatRow[],
  repoNames: Map<string, string>,
  opts: { days: number; now: Date; teamId: string | null; repoId: string | null; credentials?: ExpiringItemDto[] },
): DashboardDto {
  const { days, now } = opts;
  const since = new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY);
  const open = zero(SEVERITIES);
  const byScanner = zero<ScannerName>(SCANNERS);
  let suppressed = 0;
  for (const f of findings) {
    if (f.status === 'open') {
      open[f.severity]++;
      byScanner[f.scanner]++;
    } else if (f.status === 'suppressed') suppressed++;
  }

  // Daily open counts.
  const trend: TrendPoint[] = [];
  const counted = findings.filter((f) => f.status !== 'suppressed');
  for (let t = since.getTime(); t <= startOfUtcDay(now).getTime(); t += DAY) {
    const endOfDay = t + DAY;
    const bySeverity = zero(SEVERITIES);
    for (const f of counted) if (f.firstSeenAt.getTime() < endOfDay && (!f.fixedAt || f.fixedAt.getTime() >= endOfDay)) bySeverity[f.severity]++;
    trend.push({ date: dayKey(new Date(t)), bySeverity, total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0) });
  }

  // Weekly opened vs fixed.
  const weeks = new Map<string, NewVsFixedPoint>();
  for (let w = mondayOf(since).getTime(); w <= now.getTime(); w += 7 * DAY) weeks.set(dayKey(new Date(w)), { week: dayKey(new Date(w)), opened: 0, fixed: 0 });
  for (const f of findings) {
    if (f.firstSeenAt >= since) {
      const w = weeks.get(dayKey(mondayOf(f.firstSeenAt)));
      if (w) w.opened++;
    }
    if (f.fixedAt && f.fixedAt >= since) {
      const w = weeks.get(dayKey(mondayOf(f.fixedAt)));
      if (w) w.fixed++;
    }
  }

  // Mean time to remediate, by severity, for findings fixed in the period.
  const ttr = new Map<Severity, number[]>();
  for (const f of findings) {
    if (!f.fixedAt || f.fixedAt < since) continue;
    ttr.set(f.severity, [...(ttr.get(f.severity) ?? []), (f.fixedAt.getTime() - f.firstSeenAt.getTime()) / DAY]);
  }
  const mttrDays = Object.fromEntries(SEVERITIES.map((s) => {
    const xs = ttr.get(s);
    return [s, xs?.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null];
  })) as Record<Severity, number | null>;

  // SLA compliance: tickets resolved in the period, resolved by their due date.
  const resolved = tickets.filter((t) => t.resolvedAt && t.resolvedAt >= since);
  const onTime = resolved.filter((t) => !t.dueAt || t.resolvedAt! <= t.dueAt).length;
  const active = tickets.filter((t) => ACTIVE_TICKETS.has(t.status));

  // Riskiest repositories by the summed risk of open findings.
  const repos = new Map<string, RiskyRepoDto>();
  for (const f of findings) {
    if (f.status !== 'open') continue;
    const r = repos.get(f.repoId) ?? { repoId: f.repoId, fullName: repoNames.get(f.repoId) ?? f.repoId, openFindings: 0, critical: 0, high: 0, riskTotal: 0 };
    r.openFindings++;
    r.riskTotal += f.riskScore;
    if (f.severity === 'critical') r.critical++;
    if (f.severity === 'high') r.high++;
    repos.set(f.repoId, r);
  }
  const topRepos = [...repos.values()].sort((a, b) => b.riskTotal - a.riskTotal || b.critical - a.critical).slice(0, 10);

  // Certificates and tokens expiring (or expired) in the coming months, plus tracked credentials.
  const expiring: ExpiringItemDto[] = [];
  for (const f of findings) {
    if (f.status !== 'open' || f.scanner !== 'certificates') continue;
    const at = expiryOf(f);
    if (!at) continue;
    const daysLeft = Math.floor((at.getTime() - now.getTime()) / DAY);
    if (daysLeft <= EXPIRY_HORIZON_DAYS) expiring.push({ kind: 'certificate', title: f.title, repoId: f.repoId, location: repoNames.get(f.repoId) ?? null, expiresAt: at.toISOString(), daysLeft });
  }
  for (const c of opts.credentials ?? []) if (c.daysLeft <= EXPIRY_HORIZON_DAYS) expiring.push(c);
  expiring.sort((a, b) => a.daysLeft - b.daysLeft);

  // End-of-life frameworks still in use, by product and release cycle.
  const eol = new Map<string, EolExposureDto & { repoIds: Set<string> }>();
  for (const f of findings) {
    if (f.status !== 'open' || f.scanner !== 'frameworks') continue;
    const product = typeof f.details?.product === 'string' ? f.details.product : null;
    const cycle = typeof f.details?.cycle === 'string' ? f.details.cycle : null;
    if (!product || !cycle) continue;
    const key = `${product}|${cycle}`;
    const e = eol.get(key) ?? { product, cycle, eol: typeof f.details?.eol === 'string' ? f.details.eol.slice(0, 10) : null, repos: 0, repoIds: new Set<string>() };
    e.repoIds.add(f.repoId);
    e.repos = e.repoIds.size;
    eol.set(key, e);
  }

  return {
    generatedAt: now.toISOString(),
    days,
    scope: { teamId: opts.teamId, repoId: opts.repoId },
    open,
    openTotal: SEVERITIES.reduce((n, s) => n + open[s], 0),
    suppressed,
    byScanner,
    trend,
    newVsFixed: [...weeks.values()],
    mttrDays,
    sla: { resolved: resolved.length, onTime, compliancePct: resolved.length ? Math.round((onTime / resolved.length) * 1000) / 10 : null, active: active.length, breached: active.filter((t) => t.dueAt && t.dueAt < now).length },
    topRepos,
    expiring: expiring.slice(0, 50),
    eol: [...eol.values()].map(({ repoIds: _r, ...e }) => e).sort((a, b) => b.repos - a.repos || (a.eol ?? '').localeCompare(b.eol ?? '')),
  };
}
