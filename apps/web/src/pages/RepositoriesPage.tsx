import { type Criticality, CRITICALITIES, type Paged, type RepositoryDto, SCHEDULE_LABELS, SCHEDULE_PRESETS, type SchedulePreset, type SourceDto, type TeamDto } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FolderGit2, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ScanStatusBadge, scheduleLabel } from '../components/scans';
import { Badge, Button, Card, CenteredSpinner, EmptyState, ErrorAlert, Input, PageHeader, Pagination, Select, Table } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatRelative } from '../lib/utils';

const PAGE_SIZE = 50;

type BulkPatch = { active?: boolean; teamId?: string | null; criticality?: Criticality; schedule?: { preset: SchedulePreset } };

export function RepositoriesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('repos:manage');
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sourceId = params.get('source') ?? '';
  const teamId = params.get('team') ?? '';
  const active = params.get('active') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
    setPage(1);
    setSelected(new Set());
  };

  const sources = useQuery({ queryKey: ['sources', 'summary'], queryFn: () => api<Pick<SourceDto, 'id' | 'name' | 'provider'>[]>('/sources/summary') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
  const teamNames = new Map((teams.data ?? []).map((t) => [t.id, t.name]));
  const sourceNames = new Map((sources.data ?? []).map((s) => [s.id, s.name]));

  const query = useQuery({
    queryKey: ['repos', { search, sourceId, teamId, active, page }],
    queryFn: () => api<Paged<RepositoryDto>>('/repos', { query: { search, sourceId, teamId, active, page, pageSize: PAGE_SIZE } }),
    placeholderData: (prev) => prev,
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.lastScanStatus === 'queued' || r.lastScanStatus === 'running' || (r.active && !r.lastScanAt)) ? 5000 : false),
  });

  const bulk = useMutation({
    mutationFn: (patch: BulkPatch) => api<{ updated: number }>('/repos/bulk', { method: 'POST', body: { ids: [...selected], patch } }),
    onSuccess: (res) => {
      toast.success(`Updated ${res.updated} repositor${res.updated === 1 ? 'y' : 'ies'}.`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['repos'] });
      void qc.invalidateQueries({ queryKey: ['sources'] });
    },
  });

  const items = query.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((r) => selected.has(r.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <>
      <PageHeader title="Repositories" description="Choose which repositories Argus monitors, who owns them and how often they are scanned." />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input
              placeholder="Search repositories"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select className="w-auto" value={active} onChange={(e) => setParam('active', e.target.value)} aria-label="Filter by monitoring status">
            <option value="">All repositories</option>
            <option value="true">Monitored</option>
            <option value="false">Not monitored</option>
          </Select>
          <Select className="w-auto" value={sourceId} onChange={(e) => setParam('source', e.target.value)} aria-label="Filter by source">
            <option value="">All sources</option>
            {sources.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select className="w-auto" value={teamId} onChange={(e) => setParam('team', e.target.value)} aria-label="Filter by team">
            <option value="">All teams</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>

        {manage && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-indigo-100 bg-indigo-50 px-4 py-2.5 text-sm dark:border-indigo-500/20 dark:bg-indigo-500/10">
            <span className="font-medium">{selected.size} selected</span>
            <Button size="sm" loading={bulk.isPending} onClick={() => bulk.mutate({ active: true })}>
              Start monitoring
            </Button>
            <Button size="sm" variant="secondary" loading={bulk.isPending} onClick={() => bulk.mutate({ active: false })}>
              Stop monitoring
            </Button>
            <Select className="w-auto py-1" value="" onChange={(e) => e.target.value && bulk.mutate({ teamId: e.target.value === '__none' ? null : e.target.value })} aria-label="Assign team">
              <option value="">Assign team…</option>
              <option value="__none">No team</option>
              {teams.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Select className="w-auto py-1" value="" onChange={(e) => e.target.value && bulk.mutate({ schedule: { preset: e.target.value as SchedulePreset } })} aria-label="Set schedule">
              <option value="">Set schedule…</option>
              {SCHEDULE_PRESETS.filter((p) => p !== 'custom').map((p) => (
                <option key={p} value={p}>
                  {SCHEDULE_LABELS[p]}
                </option>
              ))}
            </Select>
            <Select className="w-auto py-1" value="" onChange={(e) => e.target.value && bulk.mutate({ criticality: e.target.value as Criticality })} aria-label="Set criticality">
              <option value="">Set criticality…</option>
              {CRITICALITIES.map((c) => (
                <option key={c} value={c}>
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        <ErrorAlert error={query.error ?? bulk.error} />
        {query.isLoading ? (
          <CenteredSpinner />
        ) : !items.length ? (
          <EmptyState
            icon={<FolderGit2 className="size-5" />}
            title={sources.data?.length === 0 ? 'No sources connected yet' : 'No repositories match'}
            description={
              sources.data?.length === 0
                ? 'An administrator needs to connect GitHub or Bitbucket first.'
                : can('repos:manage')
                  ? 'Try different filters, or sync the source to discover new repositories.'
                  : 'You only see repositories owned by your teams. Ask an administrator to add you to a team.'
            }
            action={sources.data?.length === 0 && can('sources:manage') && <Link to="/admin/sources"><Button>Connect a source</Button></Link>}
          />
        ) : (
          <>
            <Table
              head={[
                ...(manage
                  ? [<input key="all" type="checkbox" aria-label="Select all" className="size-4 rounded border-slate-300" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((r) => r.id)))} />]
                  : []),
                'Repository',
                'Team',
                'Schedule',
                'Last scan',
              ]}
            >
              {items.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'bg-indigo-50/50 dark:bg-indigo-500/5' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}>
                  {manage && (
                    <td className="w-10 px-4 py-3">
                      <input type="checkbox" aria-label={`Select ${r.fullName}`} className="size-4 rounded border-slate-300" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/repositories/${r.id}`} className="font-medium hover:text-indigo-600 dark:hover:text-indigo-400">
                        {r.fullName}
                      </Link>
                      {r.active ? <Badge tone="green">Monitored</Badge> : <Badge>Not monitored</Badge>}
                      {r.visibility === 'public' && <Badge tone="amber">Public</Badge>}
                      {r.archived && (
                        <Badge>
                          <Archive className="mr-1 size-3" />
                          Archived
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {sourceNames.get(r.sourceId)}
                      {r.language && ` · ${r.language}`}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{r.teamId ? teamNames.get(r.teamId) : <span className="text-slate-400">Unassigned</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600 dark:text-slate-300">{r.active ? scheduleLabel(r.schedule) : '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <ScanStatusBadge status={r.lastScanStatus} />
                      {r.lastScanAt && <span className="text-xs text-slate-500">{formatRelative(r.lastScanAt)}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
