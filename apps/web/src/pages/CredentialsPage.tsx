import {
  CREDENTIAL_KIND_LABELS,
  CREDENTIAL_KINDS,
  type CredentialDto,
  type CredentialKind,
  type EntraImportSettingsDto,
  type Paged,
  type TeamDto,
} from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RefreshCw } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Pagination, Select, Table } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatRelative } from '../lib/utils';

function Expiry({ c }: { c: CredentialDto }) {
  const tone = c.daysLeft < 0 ? 'red' : c.daysLeft <= 7 ? 'red' : c.daysLeft <= 30 ? 'amber' : 'green';
  return (
    <div>
      <div className="tabular-nums">{c.expiresAt.slice(0, 10)}</div>
      <Badge tone={tone}>{c.daysLeft < 0 ? `Expired ${-c.daysLeft} day(s) ago` : c.daysLeft === 0 ? 'Expires today' : `${c.daysLeft} day(s) left`}</Badge>
    </div>
  );
}

type Form = { name: string; kind: CredentialKind; system: string; owner: string; teamId: string; expiresAt: string; notes: string; notifyEmails: string };

function CredentialModal({ credential, teams, onClose }: { credential: CredentialDto | null; teams: TeamDto[]; onClose(): void }) {
  const qc = useQueryClient();
  const imported = credential?.source === 'entra';
  const [f, setF] = useState<Form>({
    name: credential?.name ?? '',
    kind: credential?.kind ?? 'api_key',
    system: credential?.system ?? '',
    owner: credential?.owner ?? '',
    teamId: credential?.teamId ?? '',
    expiresAt: credential?.expiresAt.slice(0, 10) ?? '',
    notes: credential?.notes ?? '',
    notifyEmails: credential?.notifyEmails.join(', ') ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        teamId: f.teamId || null,
        expiresAt: new Date(`${f.expiresAt}T23:59:59Z`).toISOString(),
        notifyEmails: f.notifyEmails.split(/[,;\s]+/).filter(Boolean),
      };
      return credential ? api(`/credentials/${credential.id}`, { method: 'PATCH', body }) : api('/credentials', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credentials'] });
      toast.success(credential ? 'Credential updated.' : 'Credential added.');
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
      wide
      onClose={onClose}
      title={credential ? `Edit ${credential.name}` : 'Track a credential'}
      description="Record what the credential is, who owns it and when it expires. Never paste the secret itself."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="credential-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="credential-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={save.error} />
        {imported && <p className="text-sm text-slate-500">Imported from Microsoft Entra ID: the name, kind and expiry follow Entra; you can set the team, owner, notes and recipients.</p>}
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} disabled={imported} placeholder="e.g. Payments API key (production)" />}</Field>
          <Field label="Kind">
            {(id) => (
              <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as CredentialKind })} disabled={imported}>
                {CREDENTIAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CREDENTIAL_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="System">{(id) => <Input id={id} value={f.system} onChange={(e) => setF({ ...f, system: e.target.value })} disabled={imported} placeholder="e.g. Stripe" />}</Field>
          <Field label="Expires on">{(id) => <Input id={id} type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} required disabled={imported} />}</Field>
          <Field label="Owner">{(id) => <Input id={id} value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} placeholder="Person or team responsible" />}</Field>
          <Field label="Team" hint="Team members see it; leave empty for administrators and security managers only.">
            {(id) => (
              <Select id={id} value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
                <option value="">Organisation-wide</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Also notify" hint="Comma-separated emails, used by notification rules that include repository recipients.">
            {(id) => <Input id={id} value={f.notifyEmails} onChange={(e) => setF({ ...f, notifyEmails: e.target.value })} />}
          </Field>
          <Field label="Notes">{(id) => <Input id={id} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Where it is used, how to rotate it" />}</Field>
        </fieldset>
      </form>
    </Modal>
  );
}

function EntraCard({ teams }: { teams: TeamDto[] }) {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ['credentials', 'entra'], queryFn: () => api<EntraImportSettingsDto | null>('/credentials/entra') });
  const [f, setF] = useState({ enabled: true, tenantId: '', clientId: '', clientSecret: '', teamId: '' });
  useEffect(() => {
    const d = current.data;
    if (d) setF({ enabled: d.enabled, tenantId: d.tenantId, clientId: d.clientId, clientSecret: '', teamId: d.teamId ?? '' });
  }, [current.data]);
  const save = useMutation({
    mutationFn: () => api<EntraImportSettingsDto>('/credentials/entra', { method: 'PUT', body: { ...f, teamId: f.teamId || null, clientSecret: f.clientSecret || undefined } }),
    onSuccess: (d) => {
      qc.setQueryData(['credentials', 'entra'], d);
      toast.success('Entra ID import saved.');
    },
  });
  const sync = useMutation({
    mutationFn: () => api<EntraImportSettingsDto>('/credentials/entra/sync', { method: 'POST' }),
    onSuccess: (d) => {
      qc.setQueryData(['credentials', 'entra'], d);
      void qc.invalidateQueries({ queryKey: ['credentials', 'list'] });
      if (d.lastSyncError) toast.error(d.lastSyncError);
      else toast.success(`Imported ${d.lastSyncCount ?? 0} credential(s).`);
    },
  });
  const d = current.data;
  return (
    <Card>
      <CardHeader
        title="Microsoft Entra ID import"
        description="Imports every app registration's client secrets and certificates daily, so their expiry is tracked here. Needs an app with the Application.Read.All application permission (admin consent)."
        actions={
          d && (
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={sync.isPending} onClick={() => sync.mutate()}>
              Sync now
            </Button>
          )
        }
      />
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <ErrorAlert error={save.error ?? sync.error} />
        {d?.lastSyncAt && (
          <p className={`text-sm ${d.lastSyncError ? 'text-red-600' : 'text-slate-500'}`}>
            Last sync {formatRelative(d.lastSyncAt)}: {d.lastSyncError ?? `${d.lastSyncCount} credential(s)`}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Directory (tenant) ID">{(id) => <Input id={id} value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value })} required />}</Field>
          <Field label="Application (client) ID">{(id) => <Input id={id} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} required />}</Field>
          <Field label="Client secret" hint={d?.secretConfigured ? `Leave empty to keep the stored secret (${d.secretHint}).` : 'Stored encrypted; never shown again.'}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} required={!d?.secretConfigured} />}
          </Field>
          <Field label="Assign imported credentials to">
            {(id) => (
              <Select id={id} value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
                <option value="">Organisation-wide</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Checkbox label="Import daily" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
      </form>
    </Card>
  );
}

export function CredentialsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const manage = can('credentials:manage');
  const [search, setSearch] = useState('');
  const [expiring, setExpiring] = useState('');
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<CredentialDto | null | undefined>(undefined);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
  const list = useQuery({
    queryKey: ['credentials', 'list', search, expiring, archived, page],
    queryFn: () => api<Paged<CredentialDto>>('/credentials', { query: { search: search || undefined, expiringWithinDays: expiring || undefined, archived, page, pageSize: 25 } }),
  });
  const archive = useMutation({
    mutationFn: (c: CredentialDto) => api(`/credentials/${c.id}`, { method: 'PATCH', body: { archived: !c.archived } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['credentials'] }),
  });

  return (
    <>
      <PageHeader
        title="Credentials"
        description="API keys, client secrets, certificates and passwords your systems depend on, with expiry notices. Argus tracks them; it never stores the secrets."
        actions={
          manage && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>
              Track credential
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input aria-label="Search" placeholder="Search name, system or owner" className="w-64" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        <Select aria-label="Expiring" className="w-52" value={expiring} onChange={(e) => (setExpiring(e.target.value), setPage(1))}>
          <option value="">Any expiry</option>
          <option value="0">Expired</option>
          <option value="30">Expiring within 30 days</option>
          <option value="90">Expiring within 90 days</option>
        </Select>
        <Checkbox label="Archived" checked={archived} onChange={(e) => (setArchived(e.target.checked), setPage(1))} />
      </div>
      <ErrorAlert error={list.error ?? archive.error} />
      {list.data && list.data.items.length === 0 ? (
        <EmptyState icon={<KeyRound className="size-5" />} title="No credentials" description={manage ? 'Track the secrets and certificates your services depend on, or import them from Microsoft Entra ID below.' : undefined} />
      ) : (
        <Card>
          <Table head={['Credential', 'System', 'Owner / team', 'Expires', 'Source', '']}>
            {list.data?.items.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-slate-500">{CREDENTIAL_KIND_LABELS[c.kind]}</div>
                </td>
                <td className="px-4 py-2 text-sm">{c.system || '—'}</td>
                <td className="px-4 py-2 text-sm">
                  {c.owner || '—'}
                  <div className="text-xs text-slate-500">{c.teamName ?? 'Organisation-wide'}</div>
                </td>
                <td className="px-4 py-2 text-sm">
                  <Expiry c={c} />
                </td>
                <td className="px-4 py-2 text-sm">{c.source === 'entra' ? 'Entra ID' : 'Manual'}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {manage && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" loading={archive.isPending && archive.variables?.id === c.id} onClick={() => archive.mutate(c)}>
                        {c.archived ? 'Restore' : 'Archive'}
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {list.data && <Pagination page={page} pageSize={25} total={list.data.total} onPage={setPage} />}
      {can('settings:manage') && (
        <div className="mt-6">
          <EntraCard teams={teams.data ?? []} />
        </div>
      )}
      {editing !== undefined && <CredentialModal credential={editing} teams={teams.data ?? []} onClose={() => setEditing(undefined)} />}
    </>
  );
}
