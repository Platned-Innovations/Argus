import { FINDING_STATUSES, type FindingDto, type FindingStatus, type Paged, SCANNER_LABELS, SCANNERS, type ScannerName, type Severity, SEVERITIES } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { cn, formatRelative } from '../lib/utils';
import { EmptyFindings, FindingModal, FindingStatusBadge, findingLocation, SeverityBadge } from './findings';
import { CenteredSpinner, ErrorAlert, Input, Pagination, Select, Table } from './ui';
import { AiHintBadge } from './ai';

const PAGE_SIZE = 50;

/** Filterable, paginated findings list; scoped to one repository when `repoId` is given. */
export function FindingsTable({ repoId, initialStatus = 'open' }: { repoId?: string; initialStatus?: FindingStatus | '' }) {
  const [severities, setSeverities] = useState<Severity[]>([]);
  const [scanner, setScanner] = useState<ScannerName | ''>('');
  const [status, setStatus] = useState<FindingStatus | ''>(initialStatus);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['findings', { repoId, severities, scanner, status, search, page }],
    queryFn: () => api<Paged<FindingDto>>('/findings', { query: { repoId, severity: severities.join(','), scanner, status, search, page, pageSize: PAGE_SIZE } }),
    placeholderData: (prev) => prev,
  });
  const reset = () => setPage(1);
  const toggleSeverity = (s: Severity) => {
    setSeverities(severities.includes(s) ? severities.filter((x) => x !== s) : [...severities, s]);
    reset();
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <Input
            placeholder="Search title, rule, path or package"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              reset();
            }}
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Severity">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={severities.includes(s)}
              onClick={() => toggleSeverity(s)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium capitalize ring-1 ring-inset',
                severities.includes(s) ? 'bg-indigo-600 text-white ring-indigo-600' : 'text-slate-600 ring-slate-300 hover:bg-slate-50 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800',
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <Select className="w-auto" value={scanner} onChange={(e) => (setScanner(e.target.value as ScannerName | ''), reset())} aria-label="Scanner">
          <option value="">All scanners</option>
          {SCANNERS.map((s) => (
            <option key={s} value={s}>
              {SCANNER_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={status} onChange={(e) => (setStatus(e.target.value as FindingStatus | ''), reset())} aria-label="Status">
          <option value="">Any status</option>
          {FINDING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </Select>
      </div>
      <ErrorAlert error={query.error} />
      {query.isLoading ? (
        <CenteredSpinner />
      ) : !query.data?.items.length ? (
        <EmptyFindings />
      ) : (
        <>
          <Table head={['Risk', 'Finding', ...(repoId ? [] : ['Repository']), 'Status', 'Last seen']}>
            {query.data.items.map((f) => (
              <tr key={f.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setOpen(f.id)}>
                <td className="px-4 py-3">
                  <SeverityBadge severity={f.severity} score={f.riskScore} />
                </td>
                <td className="max-w-xl px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {f.title}
                    {f.aiHint && <AiHintBadge hint={f.aiHint} />}
                  </div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {SCANNER_LABELS[f.scanner]} · <code>{findingLocation(f)}</code>
                  </div>
                </td>
                {!repoId && <td className="px-4 py-3 whitespace-nowrap text-slate-600 dark:text-slate-300">{f.repoFullName}</td>}
                <td className="px-4 py-3">
                  <FindingStatusBadge status={f.status} />
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-500">{formatRelative(f.lastSeenAt)}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={query.data.total} onPage={setPage} />
        </>
      )}
      {open && <FindingModal findingId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
