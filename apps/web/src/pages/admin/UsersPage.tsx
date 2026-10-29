import { type CreatedUserResponse, type InviteCreatedDto, type InviteDto, type InviteSendResultDto, type InviteStatus, MAX_INVITE_DAYS, MAX_INVITE_USES, type Paged, type Role, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type TeamDto, type UserDto, type UserStatus } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Lock, Mail, Plus, Search, ShieldCheck, Users } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { SecretReveal } from '../../components/SecretReveal';
import { Badge, Button, Card, CardHeader, CenteredSpinner, Checkbox, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Pagination, Select, Table } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, formatRelative } from '../../lib/utils';

const PAGE_SIZE = 25;

function useTeams() {
  return useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
}

function TeamPicker({ value, onChange }: { value: string[]; onChange(ids: string[]): void }) {
  const { data: teams = [] } = useTeams();
  if (!teams.length) return <p className="text-sm text-slate-500">No teams yet. Create teams to scope repository access.</p>;
  return (
    <div className="grid max-h-40 gap-2 overflow-y-auto rounded-md p-1 sm:grid-cols-2">
      {teams.map((t) => (
        <Checkbox key={t.id} label={t.name} checked={value.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))} />
      ))}
    </div>
  );
}

function RoleSelect({ value, onChange, disabled }: { value: Role; onChange(r: Role): void; disabled?: boolean }) {
  return (
    <Field label="Role" hint={ROLE_DESCRIPTIONS[value]}>
      {(id) => (
        <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(res: CreatedUserResponse): void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ username: '', displayName: '', email: '', role: 'developer' as Role, teamIds: [] as string[], password: '', setPassword: false });
  const mutation = useMutation({
    mutationFn: () =>
      api<CreatedUserResponse>('/users', {
        method: 'POST',
        body: {
          username: form.username,
          displayName: form.displayName,
          email: form.email || null,
          role: form.role,
          teamIds: form.teamIds,
          ...(form.setPassword ? { password: form.password } : {}),
        },
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['teams'] });
      setForm({ username: '', displayName: '', email: '', role: 'developer', teamIds: [], password: '', setPassword: false });
      onCreated(res);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New user"
      description="The user must choose their own password at first sign-in."
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-user" loading={mutation.isPending}>
            Create user
          </Button>
        </>
      }
    >
      <form id="create-user" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={mutation.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username">{(id) => <Input id={id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required autoComplete="off" />}</Field>
          <Field label="Display name">{(id) => <Input id={id} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />}</Field>
          <Field label="Email" hint="Used for notifications and sign-in.">
            {(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
          </Field>
          <RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role })} />
        </div>
        <Field label="Teams">{() => <TeamPicker value={form.teamIds} onChange={(teamIds) => setForm({ ...form, teamIds })} />}</Field>
        <Checkbox
          label="Set an initial password"
          description="Otherwise a strong temporary password is generated and shown once."
          checked={form.setPassword}
          onChange={(e) => setForm({ ...form, setPassword: e.target.checked })}
        />
        {form.setPassword && (
          <Field label="Initial password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />}</Field>
        )}
      </form>
    </Modal>
  );
}

const DAY = 86_400_000;
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inviteLink = (res: InviteCreatedDto) => res.url ?? `${window.location.origin}/invite#${res.token}`;

/** Addresses typed or pasted as a list: commas, semicolons, spaces or new lines between them. */
const parseEmails = (text: string) => [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
const textareaClass =
  'block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-indigo-600 focus:ring-inset dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700';

function InviteModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(res: InviteCreatedDto): void }) {
  const qc = useQueryClient();
  const blank = () => ({ role: 'developer' as Role, teamIds: [] as string[], emails: '', maxUses: 1, expires: isoDate(new Date(Date.now() + 7 * DAY)), note: '' });
  const [form, setForm] = useState(blank);
  const emails = parseEmails(form.emails);
  const mutation = useMutation({
    mutationFn: () =>
      api<InviteCreatedDto>('/invites', {
        method: 'POST',
        body: {
          role: form.role,
          teamIds: form.teamIds,
          emails,
          maxUses: emails.length || form.maxUses,
          // Valid until the end of the chosen day, in the administrator's time zone.
          expiresAt: new Date(`${form.expires}T23:59:59`).toISOString(),
          note: form.note,
        },
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['invites'] });
      setForm(blank());
      onCreated(res);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite users"
      description="Create a link people use to set up their own account, with the role and teams you choose."
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-invite" loading={mutation.isPending}>
            Create invite link
          </Button>
        </>
      }
    >
      <form id="create-invite" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={mutation.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role })} />
          <Field label="Link expires" hint="At the end of this day.">
            {(id) => (
              <Input id={id} type="date" required value={form.expires} min={isoDate(new Date(Date.now() + DAY))} max={isoDate(new Date(Date.now() + MAX_INVITE_DAYS * DAY))} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email addresses (optional)" hint="Only these addresses can use the link, once each. You can email it to them next. Separate them with commas or new lines.">
            {(id) => <textarea id={id} rows={2} value={form.emails} onChange={(e) => setForm({ ...form, emails: e.target.value })} className={textareaClass} placeholder="ann@example.com, bob@example.com" />}
          </Field>
          <Field label="Number of accounts" hint={emails.length ? 'One for each address.' : 'How many people can sign up with this link.'}>
            {(id) => (
              <Input id={id} type="number" min={1} max={MAX_INVITE_USES} required disabled={emails.length > 0} value={emails.length || form.maxUses} onChange={(e) => setForm({ ...form, maxUses: Number(e.target.value) })} />
            )}
          </Field>
        </div>
        <Field label="Teams">{() => <TeamPicker value={form.teamIds} onChange={(teamIds) => setForm({ ...form, teamIds })} />}</Field>
        <Field label="Note (optional)" hint="Only administrators see it, e.g. who the link was sent to.">
          {(id) => <Input id={id} maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}
        </Field>
      </form>
    </Modal>
  );
}

/** Shown once after creating an invite: copy the link, or email it to the invited addresses. */
function ShareInviteModal({ created, onClose }: { created: InviteCreatedDto; onClose(): void }) {
  const { invite } = created;
  const qc = useQueryClient();
  const canEmail = invite.emails.length > 0;
  const channels = useQuery({ queryKey: ['invite-email-channels'], queryFn: () => api<{ id: string; name: string }[]>('/invites/email-channels'), enabled: canEmail });
  const [channelId, setChannelId] = useState('');
  const [message, setMessage] = useState('');
  const channel = channelId || channels.data?.[0]?.id || '';
  const send = useMutation({
    mutationFn: (only?: string[]) => api<InviteSendResultDto>(`/invites/${invite.id}/send`, { method: 'POST', body: { token: created.token, channelId: channel, baseUrl: window.location.origin, message, only } }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['invites'] });
      if (res.sent.length) toast.success(`Invite emailed to ${res.sent.length} ${res.sent.length === 1 ? 'address' : 'addresses'}.`);
    },
  });
  const failed = send.data?.failed ?? [];
  return (
    <Modal open onClose={onClose} title="Invite link created" description="Copy the link or email it. It will not be shown again once you close this window." wide footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Copy link</h3>
        <SecretReveal value={inviteLink(created)} />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {ROLE_LABELS[invite.role]}
          {canEmail ? ` · for ${invite.emails.length} ${invite.emails.length === 1 ? 'address' : 'addresses'}, once each` : ` · up to ${invite.maxUses} account${invite.maxUses === 1 ? '' : 's'}`} · expires {formatDateTime(invite.expiresAt)}
        </p>
      </div>
      <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-medium">Send by email</h3>
        {!canEmail ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Add email addresses to an invite to send it by email. This one is for anyone with the link, so copy it instead.</p>
        ) : channels.isLoading ? (
          <CenteredSpinner />
        ) : !channels.data?.length ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No email channel is set up. Add one under <strong>Integrations</strong> to send invites by email, or copy the link.
          </p>
        ) : (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">Each address gets its own message, with the link and their address filled in: {invite.emails.join(', ')}.</p>
            <ErrorAlert error={send.error ?? channels.error} />
            {failed.length > 0 && <ErrorAlert error={new Error(`Not sent to ${failed.map((f) => `${f.email} (${f.error})`).join('; ')}`)} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Send with">
                {(id) => (
                  <Select id={id} value={channel} onChange={(e) => setChannelId(e.target.value)}>
                    {channels.data.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Message (optional)" hint="Added at the top of the email.">
              {(id) => <textarea id={id} rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} className={textareaClass} />}
            </Field>
            <Button icon={<Mail className="size-4" />} loading={send.isPending} disabled={send.data && !failed.length} onClick={() => send.mutate(failed.length ? failed.map((f) => f.email) : undefined)}>
              {send.data && !failed.length ? 'Sent' : failed.length ? 'Try again' : `Send to ${invite.emails.length} ${invite.emails.length === 1 ? 'address' : 'addresses'}`}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

const INVITE_TONE: Record<InviteStatus, 'green' | 'slate' | 'amber' | 'red'> = { active: 'green', used: 'slate', expired: 'amber', revoked: 'red' };
const INVITE_LABEL: Record<InviteStatus, string> = { active: 'Active', used: 'Used', expired: 'Expired', revoked: 'Revoked' };

function InvitesCard({ teamNames }: { teamNames: Map<string, string> }) {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const query = useQuery({ queryKey: ['invites'], queryFn: () => api<InviteDto[]>('/invites') });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invites'] });
      toast.success('Invite revoked. The link no longer works.');
    },
  });
  const all = query.data ?? [];
  const shown = showAll ? all : all.filter((i) => i.status === 'active');
  return (
    <Card className="mt-6">
      <CardHeader
        title="Invite links"
        description="Links people use to create their own account. Each link is shown once, when it is created."
        actions={all.length > 0 && <Checkbox label="Show used, expired and revoked" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />}
      />
      <ErrorAlert error={query.error ?? revoke.error} />
      {query.isLoading ? (
        <CenteredSpinner />
      ) : !shown.length ? (
        <EmptyState icon={<Link2 className="size-5" />} title={all.length ? 'No active invite links' : 'No invite links yet'} description="Use Invite users to create one." />
      ) : (
        <Table head={['Invite', 'Teams', 'Accounts', 'Expires', 'Status', '']}>
          {shown.map((i) => (
            <tr key={i.id}>
              <td className="px-4 py-3">
                <Badge tone={i.role === 'admin' ? 'indigo' : i.role === 'security_manager' ? 'blue' : 'slate'}>{ROLE_LABELS[i.role]}</Badge>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400" title={i.emails.length ? i.emails.map((e) => (i.usedEmails.includes(e) ? `${e} (signed up)` : e)).join('\n') : undefined}>
                  {[
                    i.emails.length && (i.emails.length <= 2 ? i.emails.join(', ') : `${i.emails[0]} and ${i.emails.length - 1} more`),
                    i.note,
                    i.createdByName && `by ${i.createdByName}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </td>
              <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{i.teamIds.map((id) => teamNames.get(id)).filter(Boolean).join(', ') || '—'}</td>
              <td className="px-4 py-3 whitespace-nowrap">
                {i.uses} of {i.maxUses}
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-slate-500 dark:text-slate-400" title={formatRelative(i.expiresAt)}>
                {formatDateTime(i.expiresAt)}
              </td>
              <td className="px-4 py-3">
                <Badge tone={INVITE_TONE[i.status]}>{INVITE_LABEL[i.status]}</Badge>
              </td>
              <td className="px-4 py-3 text-right">
                {i.status === 'active' && (
                  <Button variant="secondary" size="sm" loading={revoke.isPending && revoke.variables === i.id} onClick={() => revoke.mutate(i.id)}>
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function EditUserModal({ user, onClose }: { user: UserDto; onClose(): void }) {
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const manage = can('users:manage');
  const isSelf = me?.id === user.id;
  const [form, setForm] = useState({ displayName: user.displayName, email: user.email ?? '', role: user.role, teamIds: user.teamIds, status: user.status });
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['teams'] });
  };

  const save = useMutation({
    mutationFn: () => api<UserDto>(`/users/${user.id}`, { method: 'PATCH', body: { ...form, email: form.email || null } }),
    onSuccess: () => {
      refresh();
      toast.success('User updated.');
      onClose();
    },
  });
  const action = useMutation({
    mutationFn: (kind: 'reset-password' | 'reset-mfa' | 'unlock' | 'revoke-sessions') => api<{ temporaryPassword?: string }>(`/users/${user.id}/${kind}`, { method: 'POST' }),
    onSuccess: (res, kind) => {
      refresh();
      if (res?.temporaryPassword) setTempPassword(res.temporaryPassword);
      else toast.success({ 'reset-mfa': 'MFA reset.', unlock: 'Account unlocked.', 'revoke-sessions': 'Sessions signed out.', 'reset-password': '' }[kind]);
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
      title={user.displayName}
      description={`@${user.username}`}
      wide
      footer={
        manage && (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="edit-user" loading={save.isPending}>
              Save changes
            </Button>
          </>
        )
      }
    >
      <ErrorAlert error={save.error ?? action.error} />
      {tempPassword && (
        <div className="space-y-2 rounded-md bg-amber-50 p-3 ring-1 ring-amber-600/20 dark:bg-amber-500/10">
          <p className="text-sm font-medium">Temporary password (shown once). The user must change it at next sign-in.</p>
          <SecretReveal value={tempPassword} />
        </div>
      )}
      <form id="edit-user" onSubmit={submit} className="space-y-4">
        <fieldset disabled={!manage} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name">{(id) => <Input id={id} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />}</Field>
            <Field label="Email">{(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
            <RoleSelect value={form.role} disabled={isSelf || !manage} onChange={(role) => setForm({ ...form, role })} />
            <Field label="Status" hint={isSelf ? 'You cannot disable your own account.' : 'Disabled users are signed out immediately.'}>
              {(id) => (
                <Select id={id} value={form.status} disabled={isSelf || !manage} onChange={(e) => setForm({ ...form, status: e.target.value as UserStatus })}>
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Teams">{() => <TeamPicker value={form.teamIds} onChange={(teamIds) => setForm({ ...form, teamIds })} />}</Field>
        </fieldset>
      </form>
      {manage && !isSelf && (
        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <Button variant="secondary" size="sm" loading={action.isPending && action.variables === 'reset-password'} onClick={() => action.mutate('reset-password')}>
            Reset password
          </Button>
          {user.mfaEnabled && (
            <Button variant="secondary" size="sm" loading={action.isPending && action.variables === 'reset-mfa'} onClick={() => action.mutate('reset-mfa')}>
              Reset MFA
            </Button>
          )}
          {user.lockedUntil && (
            <Button variant="secondary" size="sm" loading={action.isPending && action.variables === 'unlock'} onClick={() => action.mutate('unlock')}>
              Unlock account
            </Button>
          )}
          <Button variant="secondary" size="sm" loading={action.isPending && action.variables === 'revoke-sessions'} onClick={() => action.mutate('revoke-sessions')}>
            Sign out everywhere
          </Button>
        </div>
      )}
    </Modal>
  );
}

export function UsersPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedUserResponse | null>(null);
  const [inviting, setInviting] = useState(false);
  const [invited, setInvited] = useState<InviteCreatedDto | null>(null);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [params, setParams] = useSearchParams();
  const teamId = params.get('team') ?? '';
  const { data: teams = [] } = useTeams();
  const teamNames = new Map(teams.map((t) => [t.id, t.name]));

  const query = useQuery({
    queryKey: ['users', { search, role, status, teamId, page }],
    queryFn: () => api<Paged<UserDto>>('/users', { query: { search, role, status, teamId, page, pageSize: PAGE_SIZE } }),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHeader
        title="Users"
        description="People who can sign in to Argus, their roles and team memberships."
        actions={
          can('users:manage') && (
            <div className="flex gap-2">
              <Button variant="secondary" icon={<Link2 className="size-4" />} onClick={() => setInviting(true)}>
                Invite users
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New user
              </Button>
            </div>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input
              placeholder="Search name, username or email"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select className="w-auto" value={role} onChange={(e) => (setRole(e.target.value), setPage(1))} aria-label="Filter by role">
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
          <Select className="w-auto" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} aria-label="Filter by status">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
          <Select
            className="w-auto"
            value={teamId}
            onChange={(e) => {
              setParams(e.target.value ? { team: e.target.value } : {});
              setPage(1);
            }}
            aria-label="Filter by team"
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <ErrorAlert error={query.error} />
        {query.isLoading ? (
          <CenteredSpinner />
        ) : !query.data?.items.length ? (
          <EmptyState icon={<Users className="size-5" />} title="No users match" description="Try a different search or filter." />
        ) : (
          <>
            <Table head={['User', 'Role', 'Teams', 'Status', 'Last sign-in']}>
              {query.data.items.map((u) => (
                <tr key={u.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setEditing(u)}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.displayName}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      @{u.username}
                      {u.email && ` · ${u.email}`}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.role === 'admin' ? 'indigo' : u.role === 'security_manager' ? 'blue' : 'slate'}>{ROLE_LABELS[u.role]}</Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{u.teamIds.map((id) => teamNames.get(id)).filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={u.status === 'active' ? 'green' : 'slate'}>{u.status === 'active' ? 'Active' : 'Disabled'}</Badge>
                      {u.mfaEnabled && (
                        <Badge tone="green">
                          <ShieldCheck className="mr-1 size-3" />
                          MFA
                        </Badge>
                      )}
                      {u.lockedUntil && (
                        <Badge tone="red">
                          <Lock className="mr-1 size-3" />
                          Locked
                        </Badge>
                      )}
                      {u.mustChangePassword && <Badge tone="amber">Pending first sign-in</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-500 dark:text-slate-400">{formatRelative(u.lastLoginAt)}</td>
                </tr>
              ))}
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={query.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      {can('users:manage') && <InvitesCard teamNames={teamNames} />}

      <InviteModal
        open={inviting}
        onClose={() => setInviting(false)}
        onCreated={(res) => {
          setInviting(false);
          setInvited(res);
        }}
      />
      {invited && <ShareInviteModal key={invited.invite.id} created={invited} onClose={() => setInvited(null)} />}
      <CreateUserModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(res) => {
          setCreating(false);
          if (res.temporaryPassword) setCreated(res);
          else toast.success(`Created ${res.user.username}.`);
        }}
      />
      <Modal
        open={!!created}
        onClose={() => setCreated(null)}
        title="User created"
        description="Share this temporary password securely. It will not be shown again."
        footer={<Button onClick={() => setCreated(null)}>Done</Button>}
      >
        {created && (
          <>
            <p className="text-sm">
              Username: <strong>{created.user.username}</strong>
            </p>
            <SecretReveal value={created.temporaryPassword!} />
          </>
        )}
      </Modal>
      {editing && <EditUserModal key={editing.id} user={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
