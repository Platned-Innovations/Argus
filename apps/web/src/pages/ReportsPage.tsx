import { type DashboardDto, DASHBOARD_PERIODS, type TeamDto } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { PostureView } from '../components/posture';
import { Button, CenteredSpinner, ErrorAlert, PageHeader, Select } from '../components/ui';
import { api, buildQuery } from '../lib/api';
import { formatDateTime } from '../lib/utils';

/** A printable security posture report for the organisation, a team or a repository. "Print" saves it as PDF. */
export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const teamId = params.get('teamId') ?? '';
  const repoId = params.get('repoId') ?? '';
  const days = Number(params.get('days') ?? 90);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
  const query = { teamId: teamId || undefined, repoId: repoId || undefined, days };
  const report = useQuery({ queryKey: ['dashboard', query], queryFn: () => api<DashboardDto>('/dashboard', { query }) });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };
  const scopeName = repoId ? 'Repository report' : teamId ? `Team: ${teams.data?.find((t) => t.id === teamId)?.name ?? ''}` : 'Whole organisation';

  return (
    <>
      <PageHeader
        title="Security report"
        description={`${scopeName} · last ${days} days${report.data ? ` · generated ${formatDateTime(report.data.generatedAt)}` : ''}`}
        actions={
          <div className="flex gap-2 print:hidden">
            <a href={`/api/v1/reports/findings.csv${buildQuery({ teamId: teamId || undefined, repoId: repoId || undefined })}`} download>
              <Button variant="secondary" icon={<Download className="size-4" />}>
                Findings CSV
              </Button>
            </a>
            <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
              Print / save as PDF
            </Button>
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap gap-3 print:hidden">
        {!repoId && (
          <Select aria-label="Team" className="w-56" value={teamId} onChange={(e) => set('teamId', e.target.value)}>
            <option value="">All teams</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
        {repoId && (
          <Button variant="secondary" onClick={() => set('repoId', '')}>
            Show the whole organisation
          </Button>
        )}
        <Select aria-label="Period" className="w-40" value={days} onChange={(e) => set('days', e.target.value)}>
          {DASHBOARD_PERIODS.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </Select>
      </div>
      <ErrorAlert error={report.error} />
      {report.isLoading && <CenteredSpinner />}
      {report.data && <PostureView data={report.data} />}
    </>
  );
}
