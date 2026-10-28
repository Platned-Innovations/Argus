import { type AuditEntryDto, type Paged } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, ScrollText } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Badge, Button, Card, CenteredSpinner, EmptyState, ErrorAlert, Field, Input, PageHeader, Pagination, Select, Table } from '../../components/ui';
import { api, buildQuery } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';

const PAGE_SIZE = 50;

export function AuditPage() {
  const [filters, setFilters] = useState({ action: '', outcome: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const filterQuery = {
    action: filters.action.trim(),
    outcome: filters.outcome,
    from: filters.from ? new Date(filters.from).toISOString() : '',
    to: filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : '',
  };
  const query = useQuery({
    queryKey: ['audit', filterQuery, page],
    queryFn: () => api<Paged<AuditEntryDto>>('/audit', { query: { ...filterQuery, page, pageSize: PAGE_SIZE } }),
    placeholderData: (prev) => prev,
  });
  const update = (patch: Partial<typeof filters>) => {
    setFilters({ ...filters, ...patch });
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every security-relevant action: sign-ins, account changes, configuration and exports."
        actions={
          <a href={`/api/v1/audit/export${buildQuery(filterQuery)}`} download>
            <Button variant="secondary" icon={<Download className="size-4" />}>
              Export CSV
            </Button>
          </a>
        }
      />
      <Card>
        <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-4 dark:border-slate-800">
          <Field label="Action">{(id) => <Input id={id} placeholder="e.g. auth.login" value={filters.action} onChange={(e) => update({ action: e.target.value })} />}</Field>
          <Field label="Outcome">
            {(id) => (
              <Select id={id} value={filters.outcome} onChange={(e) => update({ outcome: e.target.value })}>
                <option value="">Any</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
              </Select>
            )}
          </Field>
          <Field label="From">{(id) => <Input id={id} type="date" value={filters.from} onChange={(e) => update({ from: e.target.value })} />}</Field>
          <Field label="To">{(id) => <Input id={id} type="date" value={filters.to} onChange={(e) => update({ to: e.target.value })} />}</Field>
        </div>
        <ErrorAlert error={query.error} />
        {query.isLoading ? (
          <CenteredSpinner />
        ) : !query.data?.items.length ? (
          <EmptyState icon={<ScrollText className="size-5" />} title="No audit entries" description="Nothing matches these filters." />
        ) : (
          <>
            <Table head={['Time', 'Actor', 'Action', 'Target', 'IP', 'Outcome']}>
              {query.data.items.map((e) => (
                <Fragment key={e.id}>
                  <tr className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                    <td className="px-4 py-2.5 whitespace-nowrap text-slate-500 dark:text-slate-400">{formatDateTime(e.at)}</td>
                    <td className="px-4 py-2.5">{e.actorName ?? <span className="text-slate-400">system / anonymous</span>}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{e.action}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400">{e.targetType ? `${e.targetType}:${e.targetId?.slice(0, 8)}` : '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500 dark:text-slate-400">{e.ip ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={e.outcome === 'success' ? 'green' : 'red'}>{e.outcome}</Badge>
                    </td>
                  </tr>
                  {expanded === e.id && (
                    <tr>
                      <td colSpan={6} className="bg-slate-50 px-4 py-3 dark:bg-slate-950">
                        <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify({ targetId: e.targetId, details: e.details }, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={query.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
