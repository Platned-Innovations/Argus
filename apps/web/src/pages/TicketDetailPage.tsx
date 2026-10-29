import {
  type AssigneeDto,
  type FindingDto,
  type TicketDetailDto,
  type TicketDto,
  type TicketEventDto,
  type TicketStatus,
  TICKET_STATUS_LABELS,
  TRIAGE_ONLY_STATUSES,
} from '@argus/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, EyeOff, ExternalLink, Mail, RefreshCw, SquareKanban } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { FindingModal, findingLocation, FindingStatusBadge, SeverityBadge } from '../components/findings';
import { DueBadge, TicketStatusBadge } from '../components/tickets';
import { Button, Card, CardHeader, CenteredSpinner, ErrorAlert, Field, Input, Modal, Select } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatRelative } from '../lib/utils';

const ACTIVE: TicketStatus[] = ['open', 'triaged', 'in_progress', 'reopened'];

function eventText(e: TicketEventDto): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'created':
      return `opened the ticket from ${d.findings ?? 1} finding(s)`;
    case 'comment':
      return 'commented';
    case 'status':
      return `changed the status from ${TICKET_STATUS_LABELS[d.from as TicketStatus] ?? d.from} to ${TICKET_STATUS_LABELS[d.to as TicketStatus] ?? d.to}${d.expiresAt ? ` until ${String(d.expiresAt).slice(0, 10)}` : ''}`;
    case 'assignment':
      return d.to ? `assigned it to ${d.toName ?? 'someone'}` : 'removed the assignee';
    case 'labels':
      return `set labels: ${((d.labels as string[]) ?? []).join(', ') || 'none'}`;
    case 'findings':
      return `linked ${d.added} more finding(s)`;
    case 'auto_resolved':
      return 'resolved the ticket';
    case 'reopened':
      return 'reopened the ticket';
    case 'sla_breached':
      return 'flagged the SLA as breached';
    case 'email_sent':
      return `emailed ${((d.to as string[]) ?? []).join(', ')} via ${d.channel}`;
    case 'jira_created':
      return `created Jira issue ${d.key}`;
    case 'jira_status':
      return `saw ${d.key} move to "${d.status}" in Jira`;
    case 'ai_suggestion':
      return `generated an AI-assisted remediation suggestion (${d.provider} · ${d.model})`;
  }
}

function StatusModal({ ticket, to, onClose }: { ticket: TicketDto; to: TicketStatus; onClose(): void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const accepting = TRIAGE_ONLY_STATUSES.includes(to);
  const mutation = useMutation({
    mutationFn: () => api<TicketDto>(`/tickets/${ticket.id}/status`, { method: 'POST', body: { status: to, reason: reason || undefined, expiresAt: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ticket', ticket.id] });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      toast.success(`Status changed to ${TICKET_STATUS_LABELS[to]}.`);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${TICKET_STATUS_LABELS[to]}: ${ticket.key}`}
      description={
        accepting
          ? 'Creates a suppression for this issue so it no longer counts as open risk. It is audited and shown under Suppressions.'
          : to === 'resolved'
            ? 'The next scan verifies the fix; if the issue is still found the ticket reopens.'
            : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="status-form" loading={mutation.isPending}>
            Confirm
          </Button>
        </>
      }
    >
      <form id="status-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={mutation.error} />
        <Field label={accepting ? 'Justification' : 'Note (optional)'}>
          {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} required={accepting} minLength={accepting ? 5 : undefined} maxLength={2000} />}
        </Field>
        {to === 'risk_accepted' && (
          <Field label="Accept until (optional)" hint="After this date the ticket reopens at the next scan.">
            {(id) => <Input id={id} type="date" min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} value={expires} onChange={(e) => setExpires(e.target.value)} />}
          </Field>
        )}
      </form>
    </Modal>
  );
}

function EmailModal({ ticket, onClose }: { ticket: TicketDto; onClose(): void }) {
  const qc = useQueryClient();
  const channels = useQuery({ queryKey: ['tickets', 'email-channels'], queryFn: () => api<{ id: string; name: string }[]>('/tickets/email-channels') });
  const [channelId, setChannelId] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [message, setMessage] = useState('');
  const split = (s: string) => s.split(/[,;\s]+/).filter(Boolean);
  const mutation = useMutation({
    mutationFn: () => api(`/tickets/${ticket.id}/email`, { method: 'POST', body: { channelId: channelId || channels.data?.[0]?.id, to: split(to), cc: split(cc), message } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ticket', ticket.id] });
      toast.success('Email sent.');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={`Email ${ticket.key}`}
      description="Sends the ticket details with your note. The email is recorded on the ticket."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="email-form" loading={mutation.isPending} disabled={!channels.data?.length}>
            Send
          </Button>
        </>
      }
    >
      <form id="email-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={mutation.error ?? channels.error} />
        {channels.data && !channels.data.length ? (
          <p className="text-sm text-slate-500">No email channel is configured. An administrator can add one under Administration → Integrations.</p>
        ) : (
          <>
            <Field label="Send with">
              {(id) => (
                <Select id={id} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  {channels.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="To" hint="Comma-separated addresses.">{(id) => <Input id={id} value={to} onChange={(e) => setTo(e.target.value)} required />}</Field>
              <Field label="Cc">{(id) => <Input id={id} value={cc} onChange={(e) => setCc(e.target.value)} />}</Field>
            </div>
            <Field label="Message">
              {(id) => (
                <textarea
                  id={id}
                  rows={4}
                  maxLength={5000}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="block w-full rounded-md border-0 bg-white px-3 py-2 text-sm shadow-xs ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-indigo-600 dark:bg-slate-900 dark:ring-slate-700"
                />
              )}
            </Field>
          </>
        )}
      </form>
    </Modal>
  );
}

function JiraModal({ ticket, onClose }: { ticket: TicketDto; onClose(): void }) {
  const qc = useQueryClient();
  const [projectKey, setProjectKey] = useState('');
  const [issueType, setIssueType] = useState('');
  const mutation = useMutation({
    mutationFn: () => api<{ key: string }>(`/tickets/${ticket.id}/jira`, { method: 'POST', body: { projectKey: projectKey.trim().toUpperCase() || undefined, issueType: issueType.trim() || undefined } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['ticket', ticket.id] });
      toast.success(`Created ${r.key}.`);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Create Jira issue for ${ticket.key}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="jira-form" loading={mutation.isPending}>
            Create issue
          </Button>
        </>
      }
    >
      <form id="jira-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={mutation.error} />
        <Field label="Project key" hint="Leave empty to use the repository's Jira project.">
          {(id) => <Input id={id} value={projectKey} onChange={(e) => setProjectKey(e.target.value)} placeholder="e.g. PAY" />}
        </Field>
        <Field label="Issue type" hint="Leave empty for the default issue type.">
          {(id) => <Input id={id} value={issueType} onChange={(e) => setIssueType(e.target.value)} placeholder="e.g. Bug" />}
        </Field>
      </form>
    </Modal>
  );
}

export function TicketDetailPage() {
  const { id = '' } = useParams();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const [statusTo, setStatusTo] = useState<TicketStatus | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [jiraOpen, setJiraOpen] = useState(false);
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [labels, setLabels] = useState<string | null>(null);

  const ticket = useQuery({ queryKey: ['ticket', id], queryFn: () => api<TicketDetailDto>(`/tickets/${id}`) });
  const t = ticket.data;
  const assignees = useQuery({ queryKey: ['ticket', id, 'assignees'], queryFn: () => api<AssigneeDto[]>(`/tickets/${id}/assignees`), enabled: can('tickets:write') });
  const findings = useQueries({ queries: (t?.findingIds ?? []).slice(0, 50).map((fid) => ({ queryKey: ['finding', fid], queryFn: () => api<FindingDto>(`/findings/${fid}`) })) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ticket', id] });
    void qc.invalidateQueries({ queryKey: ['tickets'] });
  };
  const update = useMutation({ mutationFn: (body: { assigneeId?: string | null; labels?: string[] }) => api(`/tickets/${id}`, { method: 'PATCH', body }), onSuccess: refresh });
  const status = useMutation({ mutationFn: (to: TicketStatus) => api(`/tickets/${id}/status`, { method: 'POST', body: { status: to } }), onSuccess: refresh });
  const addComment = useMutation({
    mutationFn: () => api(`/tickets/${id}/comments`, { method: 'POST', body: { body: comment } }),
    onSuccess: () => {
      setComment('');
      refresh();
    },
  });
  const watch = useMutation({ mutationFn: (on: boolean) => api(`/tickets/${id}/watch`, { method: on ? 'PUT' : 'DELETE' }), onSuccess: refresh });
  const syncJira = useMutation({ mutationFn: () => api(`/tickets/${id}/jira/sync`, { method: 'POST' }), onSuccess: refresh });

  if (ticket.isLoading) return <CenteredSpinner />;
  if (!t) return <ErrorAlert error={ticket.error} />;
  const triage = can('tickets:triage');
  const write = can('tickets:write');
  const accepted = t.status === 'risk_accepted' || t.status === 'false_positive';
  const targets: TicketStatus[] = (['open', 'triaged', 'in_progress', 'resolved', 'closed', 'risk_accepted', 'false_positive'] as TicketStatus[]).filter(
    (s) => s !== t.status && (triage || (!['closed', ...TRIAGE_ONLY_STATUSES].includes(s) && !accepted)),
  );
  const watching = !!me && t.watcherIds.includes(me.id);

  return (
    <>
      <Link to="/tickets" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
        <ArrowLeft className="size-4" /> Tickets
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-sm text-slate-500">{t.key}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <SeverityBadge severity={t.severity} score={t.riskScore} />
            <TicketStatusBadge status={t.status} />
            {ACTIVE.includes(t.status) && <DueBadge dueAt={t.dueAt} breached={t.slaBreached} />}
            <Link to={`/repositories/${t.repoId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
              {t.repoFullName}
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={watching ? <EyeOff className="size-4" /> : <Eye className="size-4" />} loading={watch.isPending} onClick={() => watch.mutate(!watching)}>
            {watching ? 'Unwatch' : 'Watch'}
          </Button>
          {write && (
            <Button variant="secondary" size="sm" icon={<Mail className="size-4" />} onClick={() => setEmailing(true)}>
              Email
            </Button>
          )}
          {write && !t.jira && (
            <Button variant="secondary" size="sm" icon={<SquareKanban className="size-4" />} onClick={() => setJiraOpen(true)}>
              Create Jira issue
            </Button>
          )}
          {write && targets.length > 0 && (
            <Select
              className="w-auto py-1.5"
              value=""
              aria-label="Change status"
              onChange={(e) => {
                const to = e.target.value as TicketStatus;
                if (!to) return;
                if (TRIAGE_ONLY_STATUSES.includes(to) || to === 'resolved' || to === 'closed' || accepted) setStatusTo(to);
                else status.mutate(to);
              }}
            >
              <option value="">Change status…</option>
              {targets.map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
      <ErrorAlert error={update.error ?? status.error ?? watch.error ?? syncJira.error} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {t.remediation && (
            <Card className="p-5 text-sm">
              <div className="mb-1 font-semibold">How to fix</div>
              {t.remediation}
            </Card>
          )}
          {t.description && (
            <Card className="p-5">
              <div className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">Details</div>
              <p className="text-sm whitespace-pre-line text-slate-700 dark:text-slate-300">{t.description}</p>
            </Card>
          )}
          <Card>
            <CardHeader title="Findings" description={`${t.openFindings} open of ${t.totalFindings}`} />
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {findings.map((q, i) =>
                q.data ? (
                  <li key={q.data.id}>
                    <button className="flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setOpenFinding(q.data!.id)}>
                      <FindingStatusBadge status={q.data.status} />
                      <code className="min-w-0 flex-1 truncate text-xs">{findingLocation(q.data)}</code>
                      <span className="text-xs text-slate-500">{formatRelative(q.data.lastSeenAt)}</span>
                    </button>
                  </li>
                ) : (
                  <li key={i} className="px-5 py-2.5 text-sm text-slate-400">
                    Loading…
                  </li>
                ),
              )}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Activity" />
            <ol className="space-y-4 p-5">
              {t.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <div>
                    <span className="font-medium">{e.actorName ?? 'Argus'}</span> <span className="text-slate-600 dark:text-slate-300">{eventText(e)}</span>{' '}
                    <span className="text-xs text-slate-400" title={formatDateTime(e.createdAt)}>
                      {formatRelative(e.createdAt)}
                    </span>
                  </div>
                  {e.body && <p className="mt-1 rounded-md bg-slate-50 px-3 py-2 whitespace-pre-line text-slate-700 dark:bg-slate-800/50 dark:text-slate-200">{e.body}</p>}
                </li>
              ))}
            </ol>
            {write && (
              <form
                className="space-y-2 border-t border-slate-100 p-5 dark:border-slate-800"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (comment.trim()) addComment.mutate();
                }}
              >
                <ErrorAlert error={addComment.error} />
                <textarea
                  rows={3}
                  placeholder="Add a comment"
                  value={comment}
                  maxLength={10_000}
                  onChange={(e) => setComment(e.target.value)}
                  className="block w-full rounded-md border-0 bg-white px-3 py-2 text-sm shadow-xs ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-indigo-600 dark:bg-slate-900 dark:ring-slate-700"
                />
                <Button type="submit" size="sm" loading={addComment.isPending} disabled={!comment.trim()}>
                  Comment
                </Button>
              </form>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Details" />
            <dl className="space-y-4 p-5 text-sm">
              <div>
                <dt className="mb-1 text-slate-500">Assignee</dt>
                <dd>
                  {write ? (
                    <Select value={t.assigneeId ?? ''} onChange={(e) => update.mutate({ assigneeId: e.target.value || null })} aria-label="Assignee">
                      <option value="">Unassigned</option>
                      {(assignees.data ?? [])
                        .filter((a) => triage || a.id === me?.id || a.id === t.assigneeId)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.displayName}
                          </option>
                        ))}
                    </Select>
                  ) : (
                    (t.assigneeName ?? 'Unassigned')
                  )}
                </dd>
              </div>
              <div>
                <dt className="mb-1 text-slate-500">Labels</dt>
                <dd>
                  {write ? (
                    <Input
                      value={labels ?? t.labels.join(', ')}
                      placeholder="e.g. pci, q4"
                      onChange={(e) => setLabels(e.target.value)}
                      onBlur={() => {
                        if (labels === null) return;
                        update.mutate({ labels: labels.split(',').map((l) => l.trim()).filter(Boolean) });
                        setLabels(null);
                      }}
                    />
                  ) : (
                    t.labels.join(', ') || '—'
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Due</dt>
                <dd>{t.dueAt ? formatDateTime(t.dueAt) : '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Opened</dt>
                <dd>{formatDateTime(t.createdAt)}</dd>
              </div>
              {t.resolvedAt && (
                <div>
                  <dt className="text-slate-500">Resolved</dt>
                  <dd>{formatDateTime(t.resolvedAt)}</dd>
                </div>
              )}
            </dl>
          </Card>
          {t.jira && (
            <Card>
              <CardHeader
                title="Jira"
                actions={
                  write && (
                    <Button variant="ghost" size="sm" icon={<RefreshCw className="size-4" />} loading={syncJira.isPending} onClick={() => syncJira.mutate()}>
                      Sync
                    </Button>
                  )
                }
              />
              <div className="space-y-1 p-5 text-sm">
                <a href={t.jira.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  {t.jira.key} <ExternalLink className="size-3" />
                </a>
                <div className="text-slate-500">
                  {t.jira.status ?? 'Status not synced yet'}
                  {t.jira.syncedAt && ` · synced ${formatRelative(t.jira.syncedAt)}`}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>

      {statusTo && <StatusModal ticket={t} to={statusTo} onClose={() => setStatusTo(null)} />}
      {emailing && <EmailModal ticket={t} onClose={() => setEmailing(false)} />}
      {jiraOpen && <JiraModal ticket={t} onClose={() => setJiraOpen(false)} />}
      {openFinding && <FindingModal findingId={openFinding} onClose={() => setOpenFinding(null)} />}
    </>
  );
}
