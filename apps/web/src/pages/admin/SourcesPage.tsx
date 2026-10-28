import { type Provider, PROVIDER_LABELS, PROVIDERS, type SourceDto, type SourceTestResult, type SourceWithSecretDto, type TeamDto } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Cloud, GitBranch, KeyRound, Pencil, Plug, Plus, RefreshCw, Server, Trash2, XCircle } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { SecretReveal } from '../../components/SecretReveal';
import { Badge, Button, Card, CenteredSpinner, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/utils';

const PROVIDER_ICON: Record<Provider, typeof GitBranch> = { github: GitBranch, bitbucket_cloud: Cloud, bitbucket_server: Server };

const PROVIDER_HELP: Record<Provider, { baseUrl: string; baseHint: string; scope: string; scopeHint: string; usernameHint?: string; token: string }> = {
  github: {
    baseUrl: 'GitHub Enterprise Server URL',
    baseHint: 'Leave empty for github.com. For Enterprise Server, e.g. https://github.example.com',
    scope: 'Organisation',
    scopeHint: 'Optional. Without it, every repository the token can access is listed.',
    token: 'A fine-grained token with read-only "Contents" and "Metadata" access to the repositories, or a classic token with the "repo" scope.',
  },
  bitbucket_cloud: {
    baseUrl: '',
    baseHint: '',
    scope: 'Workspace',
    scopeHint: 'The workspace ID from bitbucket.org/<workspace>.',
    usernameHint: 'Atlassian account email for an API token / app password. Leave empty for a workspace or repository access token.',
    token: 'Read-only repository access is sufficient (e.g. an access token with the "repository" scope).',
  },
  bitbucket_server: {
    baseUrl: 'Server URL',
    baseHint: 'e.g. https://bitbucket.example.com (include any context path).',
    scope: 'Project key',
    scopeHint: 'Optional. Without it, every repository the token can read is listed.',
    usernameHint: 'Leave empty for an HTTP access token (recommended).',
    token: 'An HTTP access token with "Repository read" (or "Project read") permission.',
  },
};

function SourceFormModal({ source, onClose, onCreated }: { source: SourceDto | null; onClose(): void; onCreated(r: SourceWithSecretDto): void }) {
  const qc = useQueryClient();
  const isNew = !source;
  const { data: teams = [] } = useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
  const [form, setForm] = useState({
    name: source?.name ?? '',
    provider: (source?.provider ?? 'github') as Provider,
    baseUrl: source?.baseUrl ?? '',
    scope: source?.scope ?? '',
    username: source?.username ?? '',
    token: '',
    autoActivatePattern: source?.autoActivatePattern ?? '',
    defaultTeamId: source?.defaultTeamId ?? '',
  });
  const help = PROVIDER_HELP[form.provider];
  const body = () => ({
    name: form.name,
    baseUrl: form.baseUrl || null,
    scope: form.scope || null,
    username: form.username || null,
    autoActivatePattern: form.autoActivatePattern || null,
    defaultTeamId: form.defaultTeamId || null,
    ...(form.token ? { token: form.token } : {}),
  });

  const test = useMutation({
    mutationFn: () =>
      source && !form.token
        ? api<SourceTestResult>(`/sources/${source.id}/test`, { method: 'POST' })
        : api<SourceTestResult>('/sources/test', { method: 'POST', body: { provider: form.provider, baseUrl: form.baseUrl || null, scope: form.scope || null, username: form.username || null, token: form.token } }),
  });
  const save = useMutation({
    mutationFn: (): Promise<SourceWithSecretDto | SourceDto> =>
      isNew ? api<SourceWithSecretDto>('/sources', { method: 'POST', body: { ...body(), provider: form.provider } }) : api<SourceDto>(`/sources/${source.id}`, { method: 'PATCH', body: body() }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['sources'] });
      if (isNew) onCreated(res as SourceWithSecretDto);
      else {
        toast.success('Source updated.');
        onClose();
      }
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
      title={isNew ? 'Connect a source' : `Edit ${source.name}`}
      description="Argus verifies the connection before saving. The token is encrypted and never shown again."
      footer={
        <>
          <Button variant="secondary" icon={<Plug className="size-4" />} loading={test.isPending} disabled={isNew && !form.token} onClick={() => test.mutate()}>
            Test connection
          </Button>
          <Button type="submit" form="source-form" loading={save.isPending}>
            {isNew ? 'Connect' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="source-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={save.error ?? test.error} />
        {test.data && (
          <div className={`flex items-start gap-2 rounded-md p-3 text-sm ring-1 ${test.data.ok ? 'bg-green-50 text-green-800 ring-green-600/20 dark:bg-green-500/10 dark:text-green-300' : 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300'}`}>
            {test.data.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
            {test.data.ok ? `Connected${test.data.identity ? ` as ${test.data.identity}` : ''}. ${test.data.visibleRepos ?? 0} repositories visible on the first page.` : test.data.message}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider">
            {(id) => (
              <Select id={id} value={form.provider} disabled={!isNew} onChange={(e) => setForm({ ...form, provider: e.target.value as Provider, baseUrl: '', username: '' })}>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Acme GitHub" required />}</Field>
          {form.provider !== 'bitbucket_cloud' && (
            <Field label={help.baseUrl} hint={help.baseHint}>
              {(id) => <Input id={id} type="url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} required={form.provider === 'bitbucket_server'} />}
            </Field>
          )}
          <Field label={help.scope} hint={help.scopeHint}>
            {(id) => <Input id={id} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} required={form.provider === 'bitbucket_cloud'} />}
          </Field>
          {help.usernameHint && (
            <Field label="Username (optional)" hint={help.usernameHint}>
              {(id) => <Input id={id} autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />}
            </Field>
          )}
        </div>
        <Field label="Access token" hint={help.token}>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={form.token}
              placeholder={source ? `Leave empty to keep the current token (${source.tokenHint})` : ''}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              required={isNew}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Auto-activate new repositories" hint="Comma-separated patterns, e.g. payments/*, *-api. Matching repositories start being scanned as soon as they are discovered.">
            {(id) => <Input id={id} value={form.autoActivatePattern} onChange={(e) => setForm({ ...form, autoActivatePattern: e.target.value })} />}
          </Field>
          <Field label="Default team" hint="Owner assigned to newly discovered repositories.">
            {(id) => (
              <Select id={id} value={form.defaultTeamId} onChange={(e) => setForm({ ...form, defaultTeamId: e.target.value })}>
                <option value="">No team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </form>
    </Modal>
  );
}

const WEBHOOK_STEPS: Record<Provider, string> = {
  github: 'In the organisation (or repository) settings → Webhooks → Add webhook: paste the URL, set content type to application/json, paste the secret, and choose "Just the push event".',
  bitbucket_cloud: 'In the workspace (or repository) settings → Webhooks → Add webhook: paste the URL and secret, and select the "Repository: Push" trigger.',
  bitbucket_server: 'In the project (or repository) settings → Webhooks → Create webhook: paste the URL and secret, and select the "Repository: Push" event.',
};

function WebhookModal({ data, onClose }: { data: SourceWithSecretDto; onClose(): void }) {
  const url = `${window.location.origin}${data.source.webhookPath}`;
  return (
    <Modal open onClose={onClose} wide title="Push webhook" description="Optional: lets Argus scan as soon as code is pushed instead of waiting for the schedule." footer={<Button onClick={onClose}>Done</Button>}>
      <p className="text-sm">{WEBHOOK_STEPS[data.source.provider]}</p>
      <Field label="Payload URL">{() => <SecretReveal value={url} />}</Field>
      <Field label="Secret (shown once)" hint="Argus rejects any webhook call that is not signed with this secret. Rotate it from the source menu if it leaks.">
        {() => <SecretReveal value={data.webhookSecret} />}
      </Field>
    </Modal>
  );
}

export function SourcesPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SourceDto | 'new' | null>(null);
  const [webhook, setWebhook] = useState<SourceWithSecretDto | null>(null);
  const [deleting, setDeleting] = useState<SourceDto | null>(null);
  const query = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<SourceDto[]>('/sources'),
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'pending') ? 2000 : false),
  });
  const sync = useMutation({
    mutationFn: (id: string) => api(`/sources/${id}/sync`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Sync queued. The repository list refreshes in a moment.');
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['sources'] }), 3000);
    },
  });
  const rotate = useMutation({ mutationFn: (id: string) => api<SourceWithSecretDto>(`/sources/${id}/webhook-secret`, { method: 'POST' }), onSuccess: setWebhook });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/sources/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sources'] });
      void qc.invalidateQueries({ queryKey: ['repos'] });
      toast.success('Source deleted.');
      setDeleting(null);
    },
  });

  return (
    <>
      <PageHeader
        title="Sources"
        description="Connections to GitHub and Bitbucket. Argus lists their repositories so you can choose which to monitor."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Connect source
          </Button>
        }
      />
      <ErrorAlert error={query.error ?? sync.error ?? rotate.error} />
      {query.isLoading ? (
        <CenteredSpinner />
      ) : !query.data?.length ? (
        <Card>
          <EmptyState
            icon={<Plug className="size-5" />}
            title="No sources connected"
            description="Connect a GitHub organisation, a Bitbucket Cloud workspace or a Bitbucket Data Center server to get started."
            action={<Button onClick={() => setEditing('new')}>Connect source</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {query.data.map((s) => {
            const Icon = PROVIDER_ICON[s.provider];
            return (
              <Card key={s.id} className="flex flex-col">
                <div className="flex items-start gap-3 p-5">
                  <div className="rounded-md bg-slate-100 p-2 dark:bg-slate-800">
                    <Icon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{s.name}</h2>
                      <Badge tone={s.status === 'ok' ? 'green' : s.status === 'error' ? 'red' : 'amber'}>{s.status === 'ok' ? 'Connected' : s.status === 'error' ? 'Error' : 'Syncing…'}</Badge>
                    </div>
                    <p className="truncate text-sm text-slate-500 dark:text-slate-400">
                      {PROVIDER_LABELS[s.provider]}
                      {s.scope && ` · ${s.scope}`}
                      {s.baseUrl && ` · ${new URL(s.baseUrl).host}`}
                    </p>
                    {s.lastSyncError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{s.lastSyncError}</p>}
                  </div>
                </div>
                <dl className="grid grid-cols-3 border-t border-slate-100 text-center text-sm dark:border-slate-800">
                  <div className="p-3">
                    <dt className="text-xs text-slate-500">Repositories</dt>
                    <dd className="font-semibold tabular-nums">{s.repoCount}</dd>
                  </div>
                  <div className="border-x border-slate-100 p-3 dark:border-slate-800">
                    <dt className="text-xs text-slate-500">Monitored</dt>
                    <dd className="font-semibold tabular-nums">
                      <Link className="text-indigo-600 hover:underline dark:text-indigo-400" to={`/repositories?source=${s.id}`}>
                        {s.activeRepoCount}
                      </Link>
                    </dd>
                  </div>
                  <div className="p-3">
                    <dt className="text-xs text-slate-500">Last sync</dt>
                    <dd className="font-medium">{formatRelative(s.lastSyncAt)}</dd>
                  </div>
                </dl>
                <div className="mt-auto flex flex-wrap gap-1 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
                  <Button variant="ghost" size="sm" icon={<RefreshCw className="size-4" />} loading={sync.isPending && sync.variables === s.id} onClick={() => sync.mutate(s.id)}>
                    Sync now
                  </Button>
                  <Button variant="ghost" size="sm" icon={<Pencil className="size-4" />} onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" icon={<KeyRound className="size-4" />} loading={rotate.isPending && rotate.variables === s.id} onClick={() => rotate.mutate(s.id)}>
                    New webhook secret
                  </Button>
                  <Button variant="ghost" size="sm" className="ml-auto" icon={<Trash2 className="size-4 text-red-600" />} onClick={() => setDeleting(s)}>
                    Delete
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <SourceFormModal
          key={editing === 'new' ? 'new' : editing.id}
          source={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(r) => {
            setEditing(null);
            toast.success(`${r.source.name} connected. Discovering repositories…`);
            setWebhook(r);
          }}
        />
      )}
      {webhook && <WebhookModal data={webhook} onClose={() => setWebhook(null)} />}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'source'}?`}
        description="All of its repositories, their settings and scan history are removed from Argus. Nothing is changed in the source itself."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              Delete source
            </Button>
          </>
        }
      >
        <ErrorAlert error={remove.error} />
      </Modal>
    </>
  );
}
