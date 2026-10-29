import { type FindingDto, type FindingSummary, type Paged, type Severity, type TicketSummaryDto } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, BadgeCheck, CalendarClock, CheckCircle2, Circle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { type ComponentType, useState } from 'react';
import { Link } from 'react-router';
import { FindingModal, findingLocation, SeverityBadge } from '../components/findings';
import { Card, CardHeader, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const roadmap = [
  { phase: 'Foundation', detail: 'Users, teams, roles, MFA, audit log, PostgreSQL & MongoDB, Docker', done: true },
  { phase: 'Sources & scheduling', detail: 'GitHub & Bitbucket connections, repository activation, scan schedules', done: true },
  { phase: 'Scanners & risk scoring', detail: 'Secrets, npm/NuGet vulnerabilities, framework EOL, certificates, licenses, SBOM', done: true },
  { phase: 'Tickets & integrations', detail: 'Ticket lifecycle, SLAs, email (Graph / SMTP), Jira', done: true },
  { phase: 'AI assistance', detail: 'Claude, OpenAI or Gemini fix suggestions, Jira / email drafts, scan triage', done: true },
  { phase: 'Threat intelligence', detail: 'Security news with AI extraction, Argus advisories, continuous re-matching, NVD', done: true },
  { phase: 'Enterprise polish', detail: 'Dashboards, reports, credential inventory, Azure Bicep', done: false },
];

function Tile({ label, value, hint, to, icon: Icon, tone }: { label: string; value: number | string; hint: string; to: string; icon: ComponentType<{ className?: string }>; tone?: string }) {
  return (
    <Link to={to} className="block">
      <Card className="h-full p-5 transition-shadow hover:shadow-md">
        <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
          {label}
          <Icon className="size-4" />
        </div>
        <div className={`mt-2 text-3xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</div>
        <div className="mt-1 text-xs text-slate-400">{hint}</div>
      </Card>
    </Link>
  );
}

export function DashboardPage() {
  const { me, can } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const canFindings = can('findings:read');
  const summary = useQuery({ queryKey: ['findings', 'summary'], queryFn: () => api<FindingSummary>('/findings/summary'), enabled: canFindings });
  const top = useQuery({
    queryKey: ['findings', 'top'],
    queryFn: () => api<Paged<FindingDto>>('/findings', { query: { status: 'open', pageSize: 6 } }),
    enabled: canFindings,
  });
  const tickets = useQuery({ queryKey: ['tickets', 'summary'], queryFn: () => api<TicketSummaryDto>('/tickets/summary'), enabled: can('tickets:read') });
  const s = summary.data;
  const urgent = s ? s.open.critical + s.open.high : null;

  return (
    <>
      <PageHeader title={`Welcome, ${me?.displayName ?? ''}`} description="Your organisation's security posture at a glance." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Critical & high findings" value={urgent ?? '—'} hint={s ? `${s.openTotal} open in total` : 'Open findings'} to="/findings" icon={ShieldAlert} tone={urgent ? 'text-red-600 dark:text-red-400' : undefined} />
        <Tile
          label="Overdue tickets"
          value={tickets.data?.slaBreached ?? '—'}
          hint={tickets.data ? `${tickets.data.active} active · ${tickets.data.assignedToMe} assigned to you` : 'Past their SLA'}
          to="/tickets?sla=breached"
          icon={AlarmClock}
          tone={tickets.data?.slaBreached ? 'text-red-600 dark:text-red-400' : undefined}
        />
        <Tile label="Expiring credentials" value={s?.byScanner.certificates ?? '—'} hint="Certificates, key stores and tokens" to="/findings" icon={CalendarClock} />
        <Tile
          label="Fixed in the last 30 days"
          value={s?.fixedLast30Days ?? '—'}
          hint={s ? `${s.suppressed} suppressed` : ''}
          to="/findings"
          icon={BadgeCheck}
          tone={s?.fixedLast30Days ? 'text-green-700 dark:text-green-400' : undefined}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {canFindings && (
          <Card className="lg:col-span-2">
            <CardHeader
              title="Top risks"
              description="Highest-scoring open findings."
              actions={
                <Link to="/findings" className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
                  All findings →
                </Link>
              }
            />
            {s && (
              <div className="flex flex-wrap gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
                {(['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map((sev) => (
                  <SeverityBadge key={sev} severity={sev} score={s.open[sev]} />
                ))}
              </div>
            )}
            {top.data?.items.length ? (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {top.data.items.map((f) => (
                  <li key={f.id}>
                    <button className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setOpen(f.id)}>
                      <SeverityBadge severity={f.severity} score={f.riskScore} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{f.title}</div>
                        <div className="truncate text-xs text-slate-500">
                          {f.repoFullName} · {findingLocation(f)}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-slate-500">
                <ShieldCheck className="size-5 text-green-600" />
                {top.isLoading ? 'Loading…' : 'No open findings. Monitored repositories are scanned on their schedule.'}
              </div>
            )}
          </Card>
        )}

        <Card>
          <CardHeader title="Platform roadmap" description="Argus is delivered in phases." />
          <ol className="divide-y divide-slate-100 dark:divide-slate-800">
            {roadmap.map((r) => (
              <li key={r.phase} className="flex gap-3 px-5 py-2.5">
                {r.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" /> : <Circle className="mt-0.5 size-4 shrink-0 text-slate-300 dark:text-slate-600" />}
                <div>
                  <div className="text-sm font-medium">{r.phase}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{r.detail}</div>
                </div>
              </li>
            ))}
          </ol>
          {!me?.mfaEnabled && (
            <div className="border-t border-slate-100 px-5 py-3 text-sm dark:border-slate-800">
              <Link to="/profile" className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
                Turn on multi-factor authentication →
              </Link>
            </div>
          )}
        </Card>
      </div>
      {open && <FindingModal findingId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
