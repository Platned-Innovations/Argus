import { type InvitePreviewDto, parseInviteFragment, ROLE_LABELS } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { Link2Off } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button, Card, CenteredSpinner, ErrorAlert, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useBranding } from '../lib/branding';
import { formatDateTime } from '../lib/utils';

/**
 * Public page behind an invite link: the invitee picks a username and password, then is signed in.
 * The token is in the URL fragment (/invite#<token>, or #<token>&email=<address> in emailed links), so it never
 * reaches server or proxy logs.
 */
export function InvitePage() {
  const { token, email } = parseInviteFragment(useLocation().hash);
  const branding = useBranding();
  const { me, login, logout } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: '', displayName: '', email: email ?? '', password: '', confirm: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InvitePreviewDto>('/invites/lookup', { method: 'POST', body: { token } }),
    enabled: token.length > 0,
    retry: false,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError(new Error('The passwords do not match.'));
    setBusy(true);
    setError(null);
    try {
      await api('/invites/accept', { method: 'POST', body: { token, username: form.username, displayName: form.displayName, email: form.email || null, password: form.password } });
      const res = await login(form.username, form.password);
      navigate(res.status === 'mfa_required' ? '/login' : '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const data = invite.data;
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="size-12" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Join {branding.productName}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Create your account to get started.</p>
        </div>
        <Card className="p-6">
          {invite.isLoading ? (
            <CenteredSpinner />
          ) : !data ? (
            <div className="space-y-4 text-center">
              <Link2Off className="mx-auto size-8 text-slate-400" />
              <ErrorAlert error={invite.error ?? new Error('This invite link is incomplete. Open the whole link you were sent.')} />
              <Link to="/login" className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                Go to sign in
              </Link>
            </div>
          ) : me ? (
            <div className="space-y-4 text-sm">
              <p>
                You are signed in as <strong>{me.username}</strong>. Sign out to create a new account with this invite.
              </p>
              <Button className="w-full" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
                You are invited as <strong>{ROLE_LABELS[data.role]}</strong>
                {data.teams.length > 0 && (
                  <>
                    {' '}
                    in <strong>{data.teams.join(', ')}</strong>
                  </>
                )}
                .<div className="mt-1 text-xs text-slate-500 dark:text-slate-400">This invite expires {formatDateTime(data.expiresAt)}.</div>
              </div>
              <ErrorAlert error={error} />
              <Field label="Username" hint="3–64 letters, digits, dots, dashes or underscores.">
                {(id) => <Input id={id} autoComplete="username" autoFocus required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />}
              </Field>
              <Field label="Display name">{(id) => <Input id={id} autoComplete="name" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}</Field>
              <Field label="Email" hint={data.emailRequired ? 'Use the address this invite was sent to.' : 'Optional. Used for notifications and sign-in.'}>
                {(id) => <Input id={id} type="email" autoComplete="email" required={data.emailRequired} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
              </Field>
              <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="new-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}</Field>
              <Field label="Confirm password">{(id) => <Input id={id} type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />}</Field>
              <Button type="submit" className="w-full" loading={busy}>
                Create account
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
