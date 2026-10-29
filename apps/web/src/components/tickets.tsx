import { type TicketStatus, TICKET_STATUS_LABELS } from '@argus/shared';
import { Badge } from './ui';

const STATUS_TONE: Record<TicketStatus, 'red' | 'amber' | 'blue' | 'green' | 'slate' | 'indigo'> = {
  open: 'red',
  reopened: 'red',
  triaged: 'amber',
  in_progress: 'blue',
  resolved: 'green',
  closed: 'slate',
  risk_accepted: 'indigo',
  false_positive: 'slate',
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{TICKET_STATUS_LABELS[status]}</Badge>;
}

export function DueBadge({ dueAt, breached }: { dueAt: string | null; breached: boolean }) {
  if (!dueAt) return <span className="text-slate-400">—</span>;
  const days = Math.ceil((new Date(dueAt).getTime() - Date.now()) / 86_400_000);
  if (breached) return <Badge tone="red">Overdue {Math.abs(days)}d</Badge>;
  return <span className={days <= 3 ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300'}>{days <= 0 ? 'Due today' : `${days}d left`}</span>;
}
