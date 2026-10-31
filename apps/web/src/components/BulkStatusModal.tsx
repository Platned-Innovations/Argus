import { TICKET_STATUS_LABELS, TICKET_STATUSES, TRIAGE_ONLY_STATUSES, type TicketBulkKeysResult, type TicketStatus } from '@argus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorAlert, Field, Input, Modal, Select } from './ui';

/** Splits on commas and whitespace, upper-cases and removes duplicates. */
export function parseKeys(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((k) => k.trim().toUpperCase()).filter(Boolean))];
}

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export function BulkStatusModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const triage = can('tickets:triage');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<TicketStatus>('triaged');
  const [comment, setComment] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [result, setResult] = useState<TicketBulkKeysResult | null>(null);

  const keys = parseKeys(text);
  const invalid = keys.filter((k) => !KEY.test(k));
  const statuses = TICKET_STATUSES.filter((s) => s !== 'reopened' && (triage || (!TRIAGE_ONLY_STATUSES.includes(s) && s !== 'closed')));
  const valid = keys.length > 0 && keys.length <= 500 && !invalid.length && comment.trim().length >= 5;

  const run = useMutation({
    mutationFn: () =>
      api<TicketBulkKeysResult>('/tickets/bulk-status', {
        method: 'POST',
        body: { keys, status, comment, expiresAt: status === 'risk_accepted' && expiresAt ? new Date(expiresAt).toISOString() : null },
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.updated.length) toast.success(`Moved ${r.updated.length} ticket(s) to ${TICKET_STATUS_LABELS[status]}.`);
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });

  const close = () => {
    setResult(null);
    run.reset();
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) run.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Bulk change ticket status"
      description="Enter ticket keys separated by commas and move them all to one status, with a comment."
      footer={
        result ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button loading={run.isPending} disabled={!valid} onClick={() => run.mutate()}>
              Move {keys.length || ''} ticket{keys.length === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-sm">
          <p>
            <span className="font-medium">{result.updated.length}</span> updated
            {result.unchanged.length > 0 && <>, {result.unchanged.length} already {TICKET_STATUS_LABELS[status].toLowerCase()}</>}.
          </p>
          {result.notFound.length > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              Not found (or not visible to you): <span className="font-mono">{result.notFound.join(', ')}</span>
            </p>
          )}
          {result.failed.length > 0 && (
            <ul className="space-y-1 text-red-700 dark:text-red-400">
              {result.failed.map((f) => (
                <li key={f.key}>
                  <span className="font-mono">{f.key}</span>: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <ErrorAlert error={run.error} />
          <Field
            label="Ticket keys"
            hint={`${keys.length} ticket${keys.length === 1 ? '' : 's'} (max 500)`}
            error={invalid.length ? `Not valid ticket keys: ${invalid.slice(0, 5).join(', ')}` : keys.length > 500 ? 'Too many tickets; the limit is 500.' : undefined}
          >
            {(id) => (
              <textarea
                id={id}
                rows={3}
                placeholder="ARG-1258, ARG-239, ARG-1188"
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                className="block w-full rounded-md border-0 bg-white px-3 py-2 font-mono text-sm shadow-xs ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-indigo-600 dark:bg-slate-900 dark:ring-slate-700"
              />
            )}
          </Field>
          <Field label="Move to">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)}>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {TICKET_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {status === 'risk_accepted' && (
            <Field label="Risk acceptance expires (optional)" hint="After this date the tickets reopen at the next scan.">
              {(id) => <Input id={id} type="date" value={expiresAt} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setExpiresAt(e.target.value)} />}
            </Field>
          )}
          <Field label="Comment" hint="Recorded on every ticket's activity (at least 5 characters).">
            {(id) => (
              <textarea
                id={id}
                rows={3}
                value={comment}
                maxLength={2000}
                onChange={(e) => setComment(e.target.value)}
                className="block w-full rounded-md border-0 bg-white px-3 py-2 text-sm shadow-xs ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-indigo-600 dark:bg-slate-900 dark:ring-slate-700"
              />
            )}
          </Field>
        </form>
      )}
    </Modal>
  );
}
