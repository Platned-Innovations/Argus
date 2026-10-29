import { SCANNER_LABELS, type SuppressionDto } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, Button, Card, CenteredSpinner, EmptyState, ErrorAlert, PageHeader, Table } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/utils';

export function SuppressionsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['suppressions'], queryFn: () => api<SuppressionDto[]>('/suppressions') });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ reopened: number }>(`/suppressions/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      toast.success(`Suppression removed; ${r.reopened} finding(s) reopened.`);
      void qc.invalidateQueries({ queryKey: ['suppressions'] });
      void qc.invalidateQueries({ queryKey: ['findings'] });
    },
  });
  const expired = (s: SuppressionDto) => !!s.expiresAt && new Date(s.expiresAt) < new Date();

  return (
    <>
      <PageHeader
        title="Suppressions"
        description="Accepted risks and false positives. Create them from a finding; repositories can also declare them in .argus.yml."
      />
      <Card>
        <ErrorAlert error={query.error ?? remove.error} />
        {query.isLoading ? (
          <CenteredSpinner />
        ) : !query.data?.length ? (
          <EmptyState icon={<ShieldOff className="size-5" />} title="No suppressions" description="Open a finding and choose Suppress to record an accepted risk." />
        ) : (
          <Table head={['Scope', 'Matches', 'Justification', 'Expires', 'Created', '']}>
            {query.data.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-3 whitespace-nowrap">{s.repoFullName ?? <Badge tone="indigo">All repositories</Badge>}</td>
                <td className="px-4 py-3 text-xs">
                  {s.scanner && <div>Scanner: {SCANNER_LABELS[s.scanner]}</div>}
                  {s.ruleId && <div>Rule: <code>{s.ruleId}</code></div>}
                  {s.packageName && <div>Package: <code>{s.packageName}</code></div>}
                  {s.pathPattern && <div>Path: <code>{s.pathPattern}</code></div>}
                </td>
                <td className="max-w-md px-4 py-3">{s.reason}</td>
                <td className="px-4 py-3 whitespace-nowrap">{s.expiresAt ? <Badge tone={expired(s) ? 'red' : 'amber'}>{formatDateTime(s.expiresAt)}</Badge> : 'Never'}</td>
                <td className="px-4 py-3 text-xs whitespace-nowrap text-slate-500">
                  {s.createdByName}
                  <div>{formatDateTime(s.createdAt)}</div>
                </td>
                <td className="px-4 py-3 text-right">
                  {can('tickets:triage') && (
                    <Button variant="ghost" size="sm" aria-label="Remove suppression" icon={<Trash2 className="size-4 text-red-600" />} loading={remove.isPending && remove.variables === s.id} onClick={() => remove.mutate(s.id)} />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
