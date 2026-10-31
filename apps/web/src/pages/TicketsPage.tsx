import { type Paged, type Severity, SEVERITIES, type TicketDto, type TicketStatus, TICKET_STATUSES, TICKET_STATUS_LABELS } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ListChecks, Search, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { BulkStatusModal } from '../components/BulkStatusModal';
import { SeverityBadge } from '../components/findings';
import { SavedViews } from '../components/SavedViews';
import { DueBadge, TicketStatusBadge } from '../components/tickets';
import { Button, Card, CenteredSpinner, Checkbox, EmptyState, ErrorAlert, Input, PageHeader, Pagination, Select, Table } from '../components/ui';
import { api, buildQuery } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFilters } from '../lib/filters';
import { cn } from '../lib/utils';

const PAGE_SIZE = 50;

export function TicketsPage() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filters = useFilters(true, () => {
    setPage(1);
    setSelected(new Set());
  });
  const { params, set } = filters;
  const search = params.get('q') ?? '';
  const status = params.get('status') ?? 'active';
  const assignee = params.get('assignee') ?? '';
  const severity = (params.get('severity') ?? '').split(',').filter(Boolean) as Severity[];
  const slaBreached = params.get('sla') === 'breached';

  const query = {
    status: status === 'all' ? undefined : status,
    assignee: assignee || undefined,
    severity: severity.join(',') || undefined,
    slaBreached: slaBreached ? 'true' : undefined,
    search: search || undefined,
  };
  const list = useQuery({
    queryKey: ['tickets', query, page],
    queryFn: () => api<Paged<TicketDto>>('/tickets', { query: { ...query, page, pageSize: PAGE_SIZE } }),
    placeholderData: (prev) => prev,
  });

  const bulk = useMutation({
    mutationFn: (body: { assigneeId?: string | null; status?: TicketStatus }) => api<{ updated: number }>('/tickets/bulk', { method: 'POST', body: { ids: [...selected], ...body } }),
    onSuccess: (r) => {
      toast.success(`Updated ${r.updated} ticket(s).`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });

  const items = list.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((t) => selected.has(t.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const canWrite = can('tickets:write');

  return (
    <>
      <PageHeader
        title="Tickets"
        description="Security issues to fix, one ticket per issue. Tickets open, update and resolve themselves from scan results."
        actions={
          <div className="flex gap-2">
            {canWrite && (
              <Button variant="secondary" icon={<ListChecks className="size-4" />} onClick={() => setBulkOpen(true)}>
                Bulk status
              </Button>
            )}
            <a href={`/api/v1/tickets/export${buildQuery(query)}`} download>
              <Button variant="secondary" icon={<Download className="size-4" />}>
                Export CSV
              </Button>
            </a>
          </div>
        }
      />
      <BulkStatusModal open={bulkOpen} onClose={() => setBulkOpen(false)} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input placeholder="Search key, title or label" className="pl-9" value={search} onChange={(e) => set('q', e.target.value, { replace: true })} />
          </div>
          <SavedViews page="tickets" query={params.toString()} onApply={filters.replaceAll} />
          <Select className="w-auto" value={status} onChange={(e) => set('status', e.target.value === 'active' ? '' : e.target.value)} aria-label="Status">
            <option value="active">Active</option>
            <option value="all">All statuses</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TICKET_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select className="w-auto" value={assignee} onChange={(e) => set('assignee', e.target.value)} aria-label="Assignee">
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
          </Select>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Severity">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={severity.includes(s)}
                onClick={() => set('severity', (severity.includes(s) ? severity.filter((x) => x !== s) : [...severity, s]).join(','))}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-medium capitalize ring-1 ring-inset',
                  severity.includes(s) ? 'bg-indigo-600 text-white ring-indigo-600' : 'text-slate-600 ring-slate-300 hover:bg-slate-50 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800',
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <Checkbox label="Overdue only" checked={slaBreached} onChange={(e) => set('sla', e.target.checked ? 'breached' : '')} />
        </div>

        {canWrite && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-indigo-100 bg-indigo-50 px-4 py-2.5 text-sm dark:border-indigo-500/20 dark:bg-indigo-500/10">
            <span className="font-medium">{selected.size} selected</span>
            <Button size="sm" loading={bulk.isPending} onClick={() => bulk.mutate({ assigneeId: me!.id })}>
              Assign to me
            </Button>
            {can('tickets:triage') && (
              <Button size="sm" variant="secondary" loading={bulk.isPending} onClick={() => bulk.mutate({ assigneeId: null })}>
                Unassign
              </Button>
            )}
            <Select className="w-auto py-1" value="" onChange={(e) => e.target.value && bulk.mutate({ status: e.target.value as TicketStatus })} aria-label="Set status">
              <option value="">Set status…</option>
              {(['open', 'triaged', 'in_progress', 'resolved', ...(can('tickets:triage') ? (['closed'] as const) : [])] as TicketStatus[]).map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        <ErrorAlert error={list.error ?? bulk.error} />
        {list.isLoading ? (
          <CenteredSpinner />
        ) : !items.length ? (
          <EmptyState icon={<ShieldAlert className="size-5" />} title="No tickets" description="Nothing matches these filters. New tickets are opened automatically when scans find issues." />
        ) : (
          <>
            <Table
              head={[
                ...(canWrite
                  ? [<input key="all" type="checkbox" aria-label="Select all" className="size-4 rounded border-slate-300" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((t) => t.id)))} />]
                  : []),
                'Ticket',
                'Risk',
                'Status',
                'Assignee',
                'Due',
              ]}
            >
              {items.map((t) => (
                <tr key={t.id} className={selected.has(t.id) ? 'bg-indigo-50/50 dark:bg-indigo-500/5' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}>
                  {canWrite && (
                    <td className="w-10 px-4 py-3">
                      <input type="checkbox" aria-label={`Select ${t.key}`} className="size-4 rounded border-slate-300" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                    </td>
                  )}
                  <td className="max-w-xl px-4 py-3">
                    <Link to={`/tickets/${t.id}`} className="font-medium hover:text-indigo-600 dark:hover:text-indigo-400">
                      <span className="mr-2 font-mono text-xs text-slate-500">{t.key}</span>
                      {t.title}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      {t.repoFullName}
                      {t.jira && <span className="font-mono">{t.jira.key}</span>}
                      {t.labels.map((l) => (
                        <span key={l} className="rounded bg-slate-100 px-1.5 dark:bg-slate-800">
                          {l}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <SeverityBadge severity={t.severity} score={t.riskScore} />
                  </td>
                  <td className="px-4 py-3">
                    <TicketStatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600 dark:text-slate-300">{t.assigneeName ?? <span className="text-slate-400">Unassigned</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <DueBadge dueAt={['open', 'triaged', 'in_progress', 'reopened'].includes(t.status) ? t.dueAt : null} breached={t.slaBreached} />
                  </td>
                </tr>
              ))}
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
