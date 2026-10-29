import { type DashboardDto, SEVERITIES } from '@argus/shared';
import { Link } from 'react-router';
import { GroupedBarChart, LineChart } from './charts';
import { SeverityBadge } from './findings';
import { Card, CardHeader, Table } from './ui';

function Stat({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: string }) {
  return (
    <Card className="p-4 break-inside-avoid">
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </Card>
  );
}

const fmtDays = (d: number | null) => (d === null ? '—' : d < 1 ? '< 1 day' : `${d} days`);

/** Posture, trends, remediation speed and SLA compliance. Used on the dashboard and in the printable report. */
export function PostureView({ data: d }: { data: DashboardDto }) {
  const fixed = d.newVsFixed.reduce((n, w) => n + w.fixed, 0);
  const opened = d.newVsFixed.reduce((n, w) => n + w.opened, 0);
  const trendRows = d.trend.map((p) => ({ x: p.date, total: p.total, urgent: p.bySeverity.critical + p.bySeverity.high }));
  const weekRows = d.newVsFixed.map((w) => ({ x: w.week, opened: w.opened, fixed: w.fixed }));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open critical & high" value={d.open.critical + d.open.high} hint={`${d.openTotal} open in total · ${d.suppressed} suppressed`} tone={d.open.critical + d.open.high ? 'text-red-600 dark:text-red-400' : undefined} />
        <Stat label={`Found / fixed (${d.days} days)`} value={`${opened} / ${fixed}`} hint={fixed >= opened ? 'Fixing at least as fast as finding' : 'More found than fixed'} />
        <Stat label="Mean time to fix (critical / high)" value={`${fmtDays(d.mttrDays.critical)} / ${fmtDays(d.mttrDays.high)}`} hint="First seen to fixed, findings fixed in the period" />
        <Stat
          label="SLA compliance"
          value={d.sla.compliancePct === null ? '—' : `${d.sla.compliancePct}%`}
          hint={`${d.sla.onTime} of ${d.sla.resolved} resolved on time · ${d.sla.breached} overdue now`}
          tone={d.sla.compliancePct !== null && d.sla.compliancePct < 80 ? 'text-amber-600 dark:text-amber-400' : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="break-inside-avoid">
          <CardHeader title="Open findings over time" description="Reconstructed from when findings were first seen and fixed; suppressed findings are left out." />
          <div className="p-5">
            <LineChart
              rows={trendRows}
              series={[
                { key: 'total', label: 'All open', color: 'var(--series-1)' },
                { key: 'urgent', label: 'Critical & high', color: 'var(--series-2)' },
              ]}
            />
          </div>
        </Card>
        <Card className="break-inside-avoid">
          <CardHeader title="Found vs fixed per week" description="New findings and findings fixed (verified by a scan), by week." />
          <div className="p-5">
            <GroupedBarChart
              rows={weekRows}
              series={[
                { key: 'opened', label: 'Found', color: 'var(--series-1)' },
                { key: 'fixed', label: 'Fixed', color: 'var(--series-2)' },
              ]}
            />
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="break-inside-avoid lg:col-span-2">
          <CardHeader title="Riskiest repositories" description="By the summed risk score of open findings." />
          {d.topRepos.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">No open findings.</p>
          ) : (
            <Table head={['Repository', 'Open', 'Critical', 'High', 'Risk']}>
              {d.topRepos.map((r) => (
                <tr key={r.repoId}>
                  <td className="px-4 py-2 text-sm">
                    <Link to={`/repositories/${r.repoId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                      {r.fullName}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-sm tabular-nums">{r.openFindings}</td>
                  <td className="px-4 py-2 text-sm tabular-nums">{r.critical}</td>
                  <td className="px-4 py-2 text-sm tabular-nums">{r.high}</td>
                  <td className="px-4 py-2 text-sm tabular-nums">{r.riskTotal}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card className="break-inside-avoid">
          <CardHeader title="Time to fix by severity" description={`Findings fixed in the last ${d.days} days.`} />
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {SEVERITIES.map((s) => (
              <li key={s} className="flex items-center justify-between px-5 py-2 text-sm">
                <SeverityBadge severity={s} />
                <span className="tabular-nums">{fmtDays(d.mttrDays[s])}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="break-inside-avoid">
          <CardHeader title="Expiring certificates and credentials" description="Expired, or expiring within 180 days." />
          {d.expiring.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">Nothing expiring in the next 180 days.</p>
          ) : (
            <Table head={['Item', 'Where', 'Expires']}>
              {d.expiring.slice(0, 15).map((e, i) => (
                <tr key={`${e.title}-${i}`}>
                  <td className="px-4 py-2 text-sm">
                    {e.title}
                    <div className="text-xs text-slate-500">{e.kind === 'credential' ? 'Tracked credential' : 'Found in a repository'}</div>
                  </td>
                  <td className="px-4 py-2 text-sm">{e.location ?? '—'}</td>
                  <td className={`px-4 py-2 text-sm tabular-nums ${e.daysLeft < 0 ? 'text-red-600' : e.daysLeft <= 30 ? 'text-amber-600' : ''}`}>
                    {e.expiresAt.slice(0, 10)} ({e.daysLeft < 0 ? `${-e.daysLeft} days ago` : `in ${e.daysLeft} days`})
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card className="break-inside-avoid">
          <CardHeader title="End-of-life frameworks" description="Runtimes and frameworks past (or near) their end of support." />
          {d.eol.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">No end-of-life frameworks in use.</p>
          ) : (
            <Table head={['Framework', 'End of life', 'Repositories']}>
              {d.eol.map((e) => (
                <tr key={`${e.product}-${e.cycle}`}>
                  <td className="px-4 py-2 text-sm">
                    {e.product} {e.cycle}
                  </td>
                  <td className="px-4 py-2 text-sm tabular-nums">{e.eol ?? '—'}</td>
                  <td className="px-4 py-2 text-sm tabular-nums">{e.repos}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
