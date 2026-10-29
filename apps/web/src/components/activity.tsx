import { type ActivityDto } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Clock, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn, formatRelative } from '../lib/utils';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Shows that scans or other background work are in progress; hidden while Argus is idle. */
export function ActivityIndicator({ className, panelClassName, compact }: { className?: string; panelClassName?: string; compact?: boolean }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ['activity'],
    queryFn: () => api<ActivityDto>('/activity'),
    enabled: can('repos:read'),
    refetchInterval: (q) => (isBusy(q.state.data) ? 4000 : 15000),
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const a = query.data;
  if (!a || !isBusy(a)) return null;
  const running = a.scans.runningTotal + a.tasks.reduce((n, t) => n + t.running, 0);
  const summary = running ? `${plural(running, 'task')} running` : `${plural(a.scans.queued, 'scan')} queued`;

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={summary}
        className="flex w-full items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
      >
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Clock className="size-3.5 shrink-0" />}
        <span className="flex-1 truncate text-left" aria-live="polite">
          {compact ? (
            <>
              <span className="sm:hidden">{running || a.scans.queued}</span>
              <span className="hidden sm:inline">{summary}</span>
            </>
          ) : (
            summary
          )}
        </span>
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className={cn('absolute z-50 mt-1 w-72 rounded-md border border-slate-200 bg-white p-3 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900', panelClassName)}>
          {a.scans.running.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">Scanning</h3>
              <ul className="space-y-1">
                {a.scans.running.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-indigo-500" />
                    <Link to={`/repositories/${s.repoId}`} onClick={() => setOpen(false)} className="min-w-0 flex-1 truncate hover:underline">
                      {s.repoFullName ?? 'Repository'}
                    </Link>
                    <span className="shrink-0 text-xs text-slate-500">{formatRelative(s.startedAt)}</span>
                  </li>
                ))}
              </ul>
              {a.scans.runningTotal > a.scans.running.length && <p className="mt-1 text-xs text-slate-500">and {a.scans.runningTotal - a.scans.running.length} more</p>}
            </section>
          )}
          {a.scans.queued > 0 && (
            <p className={cn('flex items-center gap-2 text-slate-600 dark:text-slate-400', a.scans.running.length > 0 && 'mt-2')}>
              <Clock className="size-3.5 shrink-0" />
              {plural(a.scans.queued, 'scan')} waiting to start
            </p>
          )}
          {a.tasks.length > 0 && (
            <section className={cn((a.scans.running.length > 0 || a.scans.queued > 0) && 'mt-3 border-t border-slate-200 pt-2 dark:border-slate-700')}>
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">Background</h3>
              <ul className="space-y-1">
                {a.tasks.map((t) => (
                  <li key={t.type} className="flex items-center gap-2">
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-indigo-500" />
                    <span className="flex-1">{t.label}</span>
                    {t.running > 1 && <span className="text-xs text-slate-500">×{t.running}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function isBusy(a: ActivityDto | undefined): boolean {
  return !!a && (a.scans.runningTotal > 0 || a.scans.queued > 0 || a.tasks.length > 0);
}
