import { BellRing, Bot, CheckCircle2, Circle, FolderGit2, Radar, ShieldAlert, ShieldCheck } from 'lucide-react';
import { type Paged, type RepositoryDto } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Card, CardHeader, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const roadmap = [
  { phase: 'Foundation', detail: 'Users, teams, roles, MFA, audit log, PostgreSQL & MongoDB, Docker', done: true },
  { phase: 'Sources & scheduling', detail: 'GitHub & Bitbucket connections, repository activation, scan schedules', done: true },
  { phase: 'Scanners & risk scoring', detail: 'Secrets, npm/NuGet vulnerabilities, framework EOL, certificate expiry, SBOM', done: false },
  { phase: 'Tickets & integrations', detail: 'Ticket lifecycle, SLAs, email (Graph / SMTP), Jira', done: false },
  { phase: 'AI assistance', detail: 'Claude, OpenAI or Gemini triage and remediation advice', done: false },
  { phase: 'Threat intelligence', detail: 'Advisory feeds and security news, continuous re-matching', done: false },
  { phase: 'Enterprise polish', detail: 'Dashboards, reports, credential inventory, Azure Bicep', done: false },
];

const tiles = [
  { label: 'Monitored repositories', icon: FolderGit2, live: true },
  { label: 'Open tickets', icon: ShieldAlert },
  { label: 'Expiring credentials', icon: BellRing },
  { label: 'Advisories tracked', icon: Radar },
];

export function DashboardPage() {
  const { me, can } = useAuth();
  const monitored = useQuery({
    queryKey: ['repos', 'monitored-count'],
    queryFn: () => api<Paged<RepositoryDto>>('/repos', { query: { active: 'true', pageSize: 1 } }),
    enabled: can('repos:read'),
  });
  return (
    <>
      <PageHeader title={`Welcome, ${me?.displayName ?? ''}`} description="Your organisation's security posture at a glance." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-5">
            <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
              {t.label}
              <t.icon className="size-4" />
            </div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{'live' in t && monitored.data ? monitored.data.total : '—'}</div>
            <div className="mt-1 text-xs text-slate-400">
              {'live' in t ? (
                <Link to="/repositories?active=true" className="hover:text-indigo-600">
                  View repositories →
                </Link>
              ) : (
                'Available once scanners ship (Phase 2)'
              )}
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Platform roadmap" description="Argus is delivered in phases. Each phase ships fully working." />
          <ol className="divide-y divide-slate-100 dark:divide-slate-800">
            {roadmap.map((r) => (
              <li key={r.phase} className="flex gap-3 px-5 py-3">
                {r.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-600" /> : <Circle className="mt-0.5 size-5 shrink-0 text-slate-300 dark:text-slate-600" />}
                <div>
                  <div className="text-sm font-medium">{r.phase}</div>
                  <div className="text-sm text-slate-500 dark:text-slate-400">{r.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <Card>
          <CardHeader title="Your account" />
          <div className="space-y-3 p-5 text-sm">
            <div className="flex items-center gap-2">
              {me?.mfaEnabled ? <ShieldCheck className="size-4 text-green-600" /> : <ShieldAlert className="size-4 text-amber-500" />}
              {me?.mfaEnabled ? 'Multi-factor authentication is on' : 'Multi-factor authentication is off'}
            </div>
            {!me?.mfaEnabled && (
              <Link to="/profile" className="inline-block font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
                Turn on MFA →
              </Link>
            )}
            {can('users:manage') && (
              <div className="flex items-start gap-2 border-t border-slate-100 pt-3 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <Bot className="mt-0.5 size-4 shrink-0" />
                Next: invite your team from <Link to="/admin/users" className="font-medium text-indigo-600 dark:text-indigo-400">Users</Link>.
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
