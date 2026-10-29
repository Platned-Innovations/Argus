import {
  type ChannelDto,
  type ChannelType,
  CHANNEL_TYPE_LABELS,
  CHANNEL_TYPES,
  type ConnectionTestDto,
  isEmailChannel,
  type JiraSettingsDto,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationRuleDto,
  type Severity,
  SEVERITIES,
  type TeamDto,
  type TicketingSettings,
} from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Pencil, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, CenteredSpinner, Checkbox, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select, Table } from '../../components/ui';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/utils';

const SMTP_PRESETS = {
  microsoft365: { label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls' },
  google: { label: 'Google Workspace / Gmail', host: 'smtp.gmail.com', port: 465, security: 'tls' },
  custom: { label: 'Other SMTP server', host: '', port: 587, security: 'starttls' },
} as const;

function TestResult({ result }: { result: ConnectionTestDto | undefined }) {
  if (!result) return null;
  return (
    <div className={`flex items-start gap-2 rounded-md p-3 text-sm ring-1 ${result.ok ? 'bg-green-50 text-green-800 ring-green-600/20 dark:bg-green-500/10 dark:text-green-300' : 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300'}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
      {result.message}
    </div>
  );
}

type ChannelForm = { type: ChannelType; name: string; enabled: boolean; config: Record<string, unknown>; secret: string };

function ChannelModal({ channel, onClose }: { channel: ChannelDto | null; onClose(): void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<ChannelForm>({
    type: channel?.type ?? 'email_smtp',
    name: channel?.name ?? '',
    enabled: channel?.enabled ?? true,
    config: channel?.config ?? { ...SMTP_PRESETS.microsoft365, authMode: 'password' },
    secret: '',
  });
  const cfg = (k: string) => (f.config[k] as string | number | undefined) ?? '';
  const setCfg = (patch: Record<string, unknown>) => setF({ ...f, config: { ...f.config, ...patch } });
  const save = useMutation({
    mutationFn: () => {
      const config = { ...f.config };
      delete config.label;
      if (f.type === 'email_smtp') config.port = Number(config.port);
      const body = { type: f.type, name: f.name, enabled: f.enabled, config: f.type === 'teams_webhook' || f.type === 'slack_webhook' ? {} : config, ...(f.secret ? { secret: f.secret } : {}) };
      return channel ? api<ChannelDto>(`/integrations/channels/${channel.id}`, { method: 'PUT', body }) : api<ChannelDto>('/integrations/channels', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations', 'channels'] });
      toast.success(channel ? 'Channel updated.' : 'Channel added.');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const secretHint = channel?.secretConfigured ? `Leave empty to keep the stored value (${channel.secretHint ?? 'set'}).` : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={channel ? `Edit ${channel.name}` : 'Add channel'}
      description="Secrets are encrypted and never shown again."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="channel-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="channel-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={save.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            {(id) => (
              <Select
                id={id}
                value={f.type}
                disabled={!!channel}
                onChange={(e) => {
                  const type = e.target.value as ChannelType;
                  setF({ ...f, type, config: type === 'email_smtp' ? { ...SMTP_PRESETS.microsoft365, authMode: 'password' } : {} });
                }}
              >
                {CHANNEL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CHANNEL_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />}</Field>
        </div>

        {f.type === 'email_graph' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Directory (tenant) ID">{(id) => <Input id={id} value={cfg('tenantId')} onChange={(e) => setCfg({ tenantId: e.target.value })} required />}</Field>
            <Field label="Application (client) ID">{(id) => <Input id={id} value={cfg('clientId')} onChange={(e) => setCfg({ clientId: e.target.value })} required />}</Field>
            <Field label="Send as mailbox" hint="The app needs the Mail.Send application permission; limit it to this mailbox with an application access policy.">
              {(id) => <Input id={id} type="email" value={cfg('sender')} onChange={(e) => setCfg({ sender: e.target.value })} required />}
            </Field>
            <Field label="Client secret" hint={secretHint}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} required={!channel} />}
            </Field>
          </div>
        )}

        {f.type === 'email_smtp' && (
          <>
            <Field label="Provider">
              {(id) => (
                <Select
                  id={id}
                  value={Object.entries(SMTP_PRESETS).find(([, p]) => p.host === cfg('host'))?.[0] ?? 'custom'}
                  onChange={(e) => {
                    const p = SMTP_PRESETS[e.target.value as keyof typeof SMTP_PRESETS];
                    setCfg({ host: p.host, port: p.port, security: p.security });
                  }}
                >
                  {Object.entries(SMTP_PRESETS).map(([k, p]) => (
                    <option key={k} value={k}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Host">{(id) => <Input id={id} value={cfg('host')} onChange={(e) => setCfg({ host: e.target.value })} required />}</Field>
              <Field label="Port">{(id) => <Input id={id} type="number" value={cfg('port')} onChange={(e) => setCfg({ port: Number(e.target.value) })} required />}</Field>
              <Field label="Encryption">
                {(id) => (
                  <Select id={id} value={String(cfg('security'))} onChange={(e) => setCfg({ security: e.target.value })}>
                    <option value="starttls">STARTTLS (587)</option>
                    <option value="tls">TLS (465)</option>
                  </Select>
                )}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Authentication" hint={cfg('host') === 'smtp.gmail.com' ? 'Google: use an app password.' : cfg('host') === 'smtp.office365.com' ? 'Microsoft 365: OAuth2 is recommended; basic auth is being retired.' : undefined}>
                {(id) => (
                  <Select id={id} value={String(cfg('authMode'))} onChange={(e) => setCfg({ authMode: e.target.value })}>
                    <option value="password">Username and password</option>
                    <option value="microsoft_oauth2">Microsoft OAuth2 (Entra ID app)</option>
                    <option value="none">None (relay)</option>
                  </Select>
                )}
              </Field>
              {cfg('authMode') !== 'none' && (
                <Field label={cfg('authMode') === 'microsoft_oauth2' ? 'Mailbox' : 'Username'}>
                  {(id) => <Input id={id} value={cfg('username')} onChange={(e) => setCfg({ username: e.target.value })} required />}
                </Field>
              )}
              {cfg('authMode') === 'microsoft_oauth2' && (
                <>
                  <Field label="Directory (tenant) ID">{(id) => <Input id={id} value={cfg('tenantId')} onChange={(e) => setCfg({ tenantId: e.target.value })} required />}</Field>
                  <Field label="Application (client) ID">{(id) => <Input id={id} value={cfg('clientId')} onChange={(e) => setCfg({ clientId: e.target.value })} required />}</Field>
                </>
              )}
              {cfg('authMode') !== 'none' && (
                <Field label={cfg('authMode') === 'microsoft_oauth2' ? 'Client secret' : 'Password'} hint={secretHint}>
                  {(id) => <Input id={id} type="password" autoComplete="new-password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} required={!channel} />}
                </Field>
              )}
              <Field label="From address">{(id) => <Input id={id} type="email" value={cfg('from')} onChange={(e) => setCfg({ from: e.target.value })} required />}</Field>
              <Field label="From name">{(id) => <Input id={id} value={cfg('fromName')} placeholder="Argus" onChange={(e) => setCfg({ fromName: e.target.value || null })} />}</Field>
            </div>
          </>
        )}

        {(f.type === 'teams_webhook' || f.type === 'slack_webhook') && (
          <Field
            label="Webhook URL"
            hint={
              f.type === 'teams_webhook'
                ? 'In Teams, create a workflow with "When a Teams webhook request is received" and paste its URL. ' + (secretHint ?? '')
                : 'A Slack incoming-webhook URL. ' + (secretHint ?? '')
            }
          >
            {(id) => <Input id={id} type="url" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} required={!channel} />}
          </Field>
        )}

        {f.type === 'webhook' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="URL">{(id) => <Input id={id} type="url" value={cfg('url')} onChange={(e) => setCfg({ url: e.target.value })} required />}</Field>
            <Field label="Signing secret" hint={secretHint ?? 'At least 16 characters. Receivers verify X-Argus-Signature (HMAC-SHA256 of "timestamp.body").'}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={16} value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} required={!channel} />}
            </Field>
          </div>
        )}
        <Checkbox label="Enabled" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
      </form>
    </Modal>
  );
}

function ChannelsCard() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ChannelDto | 'new' | null>(null);
  const [testing, setTesting] = useState<ChannelDto | null>(null);
  const [testTo, setTestTo] = useState('');
  const list = useQuery({ queryKey: ['integrations', 'channels'], queryFn: () => api<ChannelDto[]>('/integrations/channels') });
  const test = useMutation({ mutationFn: (c: ChannelDto) => api<ConnectionTestDto>(`/integrations/channels/${c.id}/test`, { method: 'POST', body: testTo ? { to: testTo } : {} }), onSettled: () => void qc.invalidateQueries({ queryKey: ['integrations', 'channels'] }) });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/integrations/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      toast.success('Channel deleted.');
    },
  });
  return (
    <Card>
      <CardHeader
        title="Channels"
        description="Where Argus sends email and chat notifications."
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add channel
          </Button>
        }
      />
      <ErrorAlert error={list.error ?? remove.error} />
      {!list.data ? (
        <CenteredSpinner />
      ) : !list.data.length ? (
        <EmptyState icon={<Send className="size-5" />} title="No channels" description="Add an email channel (Microsoft Graph, Microsoft 365, Google) or a Teams, Slack or webhook channel." />
      ) : (
        <Table head={['Channel', 'Type', 'Last used', '']}>
          {list.data.map((c) => (
            <tr key={c.id}>
              <td className="px-4 py-3">
                <div className="font-medium">
                  {c.name} {!c.enabled && <Badge>Disabled</Badge>}
                </div>
                {c.lastError && <div className="text-xs text-red-600 dark:text-red-400">{c.lastError}</div>}
              </td>
              <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{CHANNEL_TYPE_LABELS[c.type]}</td>
              <td className="px-4 py-3 text-slate-500">{formatRelative(c.lastUsedAt)}</td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="sm" icon={<Send className="size-4" />} onClick={() => (setTesting(c), test.reset())}>
                    Test
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="Edit" icon={<Pencil className="size-4" />} onClick={() => setEditing(c)} />
                  <Button variant="ghost" size="sm" aria-label="Delete" icon={<Trash2 className="size-4 text-red-600" />} onClick={() => remove.mutate(c.id)} />
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {editing && <ChannelModal key={editing === 'new' ? 'new' : editing.id} channel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {testing && (
        <Modal
          open
          onClose={() => setTesting(null)}
          title={`Test ${testing.name}`}
          footer={
            <Button loading={test.isPending} onClick={() => test.mutate(testing)}>
              Send test
            </Button>
          }
        >
          {isEmailChannel(testing.type) && <Field label="Send the test email to">{(id) => <Input id={id} type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} required />}</Field>}
          <ErrorAlert error={test.error} />
          <TestResult result={test.data} />
        </Modal>
      )}
    </Card>
  );
}

function JiraCard() {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ['integrations', 'jira'], queryFn: () => api<JiraSettingsDto | null>('/integrations/jira') });
  const [f, setF] = useState({ enabled: true, deployment: 'cloud' as 'cloud' | 'datacenter', baseUrl: '', email: '', token: '', defaultIssueType: 'Bug', label: '' });
  useEffect(() => {
    const d = current.data;
    if (d) setF({ enabled: d.enabled, deployment: d.deployment, baseUrl: d.baseUrl, email: d.email ?? '', token: '', defaultIssueType: d.defaultIssueType, label: d.label ?? '' });
  }, [current.data]);
  const save = useMutation({
    mutationFn: () => api<JiraSettingsDto>('/integrations/jira', { method: 'PUT', body: { ...f, email: f.email || null, label: f.label || null, token: f.token || undefined } }),
    onSuccess: (d) => {
      qc.setQueryData(['integrations', 'jira'], d);
      toast.success('Jira settings saved.');
    },
  });
  const test = useMutation({ mutationFn: () => api<ConnectionTestDto>('/integrations/jira/test', { method: 'POST' }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Card>
      <CardHeader title="Jira" description="Create Jira issues from tickets, in the project linked to each repository. Argus follows the issue status." />
      <form onSubmit={submit} className="space-y-4 p-5">
        <ErrorAlert error={save.error} />
        <TestResult result={test.data} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Deployment">
            {(id) => (
              <Select id={id} value={f.deployment} onChange={(e) => setF({ ...f, deployment: e.target.value as 'cloud' | 'datacenter' })}>
                <option value="cloud">Jira Cloud</option>
                <option value="datacenter">Jira Data Center / Server</option>
              </Select>
            )}
          </Field>
          <Field label="Site URL">{(id) => <Input id={id} type="url" placeholder="https://acme.atlassian.net" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} required />}</Field>
          {f.deployment === 'cloud' && <Field label="Account email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>}
          <Field label={f.deployment === 'cloud' ? 'API token' : 'Personal access token'} hint={current.data?.tokenConfigured ? `Leave empty to keep the stored token (${current.data.tokenHint}).` : undefined}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} required={!current.data?.tokenConfigured} />}
          </Field>
          <Field label="Default issue type">{(id) => <Input id={id} value={f.defaultIssueType} onChange={(e) => setF({ ...f, defaultIssueType: e.target.value })} required />}</Field>
          <Field label="Extra label (optional)">{(id) => <Input id={id} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="security" />}</Field>
        </div>
        <Checkbox label="Enabled" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
          <Button type="button" variant="secondary" loading={test.isPending} disabled={!current.data} onClick={() => test.mutate()}>
            Test connection
          </Button>
        </div>
      </form>
    </Card>
  );
}

type RuleForm = Omit<NotificationRuleDto, 'id' | 'createdAt' | 'updatedAt'>;

function RuleModal({ rule, onClose }: { rule: NotificationRuleDto | null; onClose(): void }) {
  const qc = useQueryClient();
  const channels = useQuery({ queryKey: ['integrations', 'channels'], queryFn: () => api<ChannelDto[]>('/integrations/channels') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
  const [f, setF] = useState<RuleForm>(rule ?? { name: '', enabled: true, events: ['ticket_created'], minSeverity: 'high', teamIds: [], channelIds: [], recipients: [], includeRepoRecipients: true });
  const [recipients, setRecipients] = useState((rule?.recipients ?? []).join(', '));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, recipients: recipients.split(/[,;\s]+/).filter(Boolean) };
      return rule ? api(`/integrations/rules/${rule.id}`, { method: 'PUT', body }) : api('/integrations/rules', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations', 'rules'] });
      toast.success('Rule saved.');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={rule ? `Edit ${rule.name}` : 'New notification rule'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="rule-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="rule-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={save.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />}</Field>
          <Field label="Minimum severity" hint="Ticket events below this severity are ignored.">
            {(id) => (
              <Select id={id} value={f.minSeverity} onChange={(e) => setF({ ...f, minSeverity: e.target.value as Severity })}>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="When">
          {() => (
            <div className="grid gap-2 sm:grid-cols-2">
              {NOTIFICATION_EVENTS.map((e) => (
                <Checkbox key={e} label={NOTIFICATION_EVENT_LABELS[e]} checked={f.events.includes(e)} onChange={() => setF({ ...f, events: toggle<NotificationEvent>(f.events, e) })} />
              ))}
            </div>
          )}
        </Field>
        <Field label="Send to channels">
          {() => (
            <div className="grid gap-2 sm:grid-cols-2">
              {channels.data?.map((c) => <Checkbox key={c.id} label={c.name} description={CHANNEL_TYPE_LABELS[c.type]} checked={f.channelIds.includes(c.id)} onChange={() => setF({ ...f, channelIds: toggle(f.channelIds, c.id) })} />)}
            </div>
          )}
        </Field>
        <Field label="Email recipients" hint="Comma-separated; used by email channels.">
          {(id) => <Input id={id} value={recipients} onChange={(e) => setRecipients(e.target.value)} />}
        </Field>
        <Checkbox label="Also email the repository's notification recipients" checked={f.includeRepoRecipients} onChange={(e) => setF({ ...f, includeRepoRecipients: e.target.checked })} />
        <Field label="Only for teams (optional)" hint="Leave all unchecked for every repository.">
          {() => (
            <div className="grid gap-2 sm:grid-cols-3">
              {teams.data?.map((t) => <Checkbox key={t.id} label={t.name} checked={f.teamIds.includes(t.id)} onChange={() => setF({ ...f, teamIds: toggle(f.teamIds, t.id) })} />)}
            </div>
          )}
        </Field>
        <Checkbox label="Enabled" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
      </form>
    </Modal>
  );
}

function RulesCard() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<NotificationRuleDto | 'new' | null>(null);
  const rules = useQuery({ queryKey: ['integrations', 'rules'], queryFn: () => api<NotificationRuleDto[]>('/integrations/rules') });
  const channels = useQuery({ queryKey: ['integrations', 'channels'], queryFn: () => api<ChannelDto[]>('/integrations/channels') });
  const names = new Map((channels.data ?? []).map((c) => [c.id, c.name]));
  const remove = useMutation({ mutationFn: (id: string) => api(`/integrations/rules/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['integrations', 'rules'] }) });
  return (
    <Card>
      <CardHeader
        title="Notification rules"
        description="Which events notify which channels."
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add rule
          </Button>
        }
      />
      <ErrorAlert error={rules.error ?? remove.error} />
      {!rules.data?.length ? (
        <EmptyState icon={<Send className="size-5" />} title="No rules" description="Without rules Argus only notifies when someone emails a ticket." />
      ) : (
        <Table head={['Rule', 'Events', 'Channels', '']}>
          {rules.data.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-3">
                <div className="font-medium">
                  {r.name} {!r.enabled && <Badge>Disabled</Badge>}
                </div>
                <div className="text-xs text-slate-500">{r.minSeverity} and above</div>
              </td>
              <td className="px-4 py-3 text-xs">{r.events.map((e) => NOTIFICATION_EVENT_LABELS[e]).join(', ')}</td>
              <td className="px-4 py-3 text-xs">{r.channelIds.map((id) => names.get(id) ?? '?').join(', ')}</td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="sm" aria-label="Edit" icon={<Pencil className="size-4" />} onClick={() => setEditing(r)} />
                  <Button variant="ghost" size="sm" aria-label="Delete" icon={<Trash2 className="size-4 text-red-600" />} onClick={() => remove.mutate(r.id)} />
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {editing && <RuleModal key={editing === 'new' ? 'new' : editing.id} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TicketSettingsCard() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['settings', 'ticketing'], queryFn: () => api<TicketingSettings>('/settings/ticketing') });
  const [f, setF] = useState<TicketingSettings | null>(null);
  useEffect(() => {
    if (query.data) setF(query.data);
  }, [query.data]);
  const save = useMutation({
    mutationFn: (body: TicketingSettings) => api<TicketingSettings>('/settings/ticketing', { method: 'PUT', body }),
    onSuccess: (d) => {
      qc.setQueryData(['settings', 'ticketing'], d);
      toast.success('Ticket settings saved.');
    },
  });
  if (!f) return <CenteredSpinner />;
  return (
    <Card>
      <CardHeader title="Tickets and SLAs" description="When tickets open automatically and how long each severity has to be resolved." />
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(f);
        }}
      >
        <ErrorAlert error={save.error} />
        <Field label="Open tickets automatically for findings at or above">
          {(id) => (
            <Select id={id} value={f.autoCreateMinSeverity} onChange={(e) => setF({ ...f, autoCreateMinSeverity: e.target.value as Severity })}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-5">
          {SEVERITIES.map((s) => (
            <Field key={s} label={`${s[0].toUpperCase() + s.slice(1)} SLA (days)`}>
              {(id) => <Input id={id} type="number" min={1} max={730} value={f.slaDays[s]} onChange={(e) => setF({ ...f, slaDays: { ...f.slaDays, [s]: Number(e.target.value) } })} required />}
            </Field>
          ))}
        </div>
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
      </form>
    </Card>
  );
}

export function IntegrationsPage() {
  return (
    <>
      <PageHeader title="Integrations" description="Email, chat and webhook channels, Jira, notification rules, and ticket SLAs." />
      <div className="space-y-6">
        <TicketSettingsCard />
        <ChannelsCard />
        <RulesCard />
        <JiraCard />
      </div>
    </>
  );
}
