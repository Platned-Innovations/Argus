import { SCANNER_LABELS, type ScanRunDto, type ScanStatus, type ScanTrigger, SCHEDULE_LABELS, type Schedule } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/utils';
import { Badge, CenteredSpinner, ErrorAlert, Modal } from './ui';

const STATUS_TONE: Record<ScanStatus, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = {
  succeeded: 'green',
  failed: 'red',
  running: 'blue',
  queued: 'amber',
  cancelled: 'slate',
};

export function ScanStatusBadge({ status }: { status: ScanStatus | null }) {
  if (!status) return <span className="text-slate-400">Never scanned</span>;
  const Icon = status === 'succeeded' ? CheckCircle2 : status === 'failed' ? XCircle : status === 'running' ? Loader2 : Clock;
  return (
    <Badge tone={STATUS_TONE[status]}>
      <Icon className={`mr-1 size-3 ${status === 'running' ? 'animate-spin' : ''}`} />
      {status[0].toUpperCase() + status.slice(1)}
    </Badge>
  );
}

export const TRIGGER_LABELS: Record<ScanTrigger, string> = { schedule: 'Scheduled', manual: 'Manual', push: 'Push', activation: 'First scan' };

export function scheduleLabel(s: Schedule): string {
  return s.preset === 'custom' ? `Cron: ${s.cron}` : SCHEDULE_LABELS[s.preset];
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const isActiveScan = (s: ScanStatus | null | undefined) => s === 'queued' || s === 'running';

export function ScanRunModal({ runId, onClose }: { runId: string; onClose(): void }) {
  const query = useQuery({
    queryKey: ['scan', runId],
    queryFn: () => api<ScanRunDto>(`/scans/${runId}`),
    refetchInterval: (q) => (isActiveScan(q.state.data?.status) ? 2000 : false),
  });
  const run = query.data;
  return (
    <Modal open onClose={onClose} title="Scan details" description={run?.repoFullName ?? undefined} wide>
      <ErrorAlert error={query.error} />
      {!run ? (
        <CenteredSpinner />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {[
              ['Status', <ScanStatusBadge status={run.status} />],
              ['Trigger', TRIGGER_LABELS[run.trigger]],
              ['Branch', run.branch ?? '—'],
              ['Commit', run.commitSha ? <code className="font-mono text-xs">{run.commitSha.slice(0, 12)}</code> : '—'],
              ['Queued', formatDateTime(run.queuedAt)],
              ['Duration', formatDuration(run.durationMs)],
            ].map(([k, v]) => (
              <div key={k as string}>
                <dt className="text-xs text-slate-500 dark:text-slate-400">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          {run.error && <ErrorAlert error={new Error(run.error)} />}
          {run.stats && (
            <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
              <div>
                {run.stats.files.toLocaleString()} files · {(run.stats.bytes / 1024 / 1024).toFixed(1)} MiB
              </div>
              <div className="flex flex-wrap gap-1.5">
                {run.stats.ecosystems.length ? run.stats.ecosystems.map((e) => <Badge key={e} tone="indigo">{e}</Badge>) : <span className="text-slate-500">No supported ecosystems detected</span>}
              </div>
              {run.stats.findings && (
                <div>
                  Findings: {run.stats.findings.new} new, {run.stats.findings.fixed} fixed, {run.stats.findings.reopened} reopened
                  {run.stats.dependencies !== undefined && ` · ${run.stats.dependencies} dependencies`}
                </div>
              )}
              {run.stats.scanners && (
                <table className="w-full text-xs">
                  <tbody>
                    {run.stats.scanners.map((s) => (
                      <tr key={s.scanner}>
                        <td className="py-0.5 pr-2">{SCANNER_LABELS[s.scanner]}</td>
                        <td className="py-0.5 pr-2">
                          <Badge tone={s.status === 'ok' ? 'green' : s.status === 'skipped' ? 'slate' : s.status === 'partial' ? 'amber' : 'red'}>{s.status}</Badge>
                        </td>
                        <td className="py-0.5 pr-2 tabular-nums">{s.findings} finding(s)</td>
                        <td className="py-0.5 text-slate-500">{s.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {run.stats.manifests.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-slate-600 dark:text-slate-300">{run.stats.manifests.length} manifest file(s)</summary>
                  <ul className="mt-1 max-h-40 overflow-y-auto font-mono text-xs">
                    {run.stats.manifests.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          <div>
            <div className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">Log</div>
            <pre className="max-h-72 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-200">{run.log?.join('\n') || 'No output yet.'}</pre>
          </div>
        </>
      )}
    </Modal>
  );
}
