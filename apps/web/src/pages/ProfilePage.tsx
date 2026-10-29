import { type MeDto, ROLE_LABELS } from '@argus/shared';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { ApiTokensCard } from '../components/ApiTokens';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { MfaSetup } from '../components/MfaSetup';
import { Badge, Button, Card, CardHeader, ErrorAlert, Field, Input, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/utils';

function DisableMfa() {
  const { setMe } = useAuth();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const mutation = useMutation({
    mutationFn: () => api('/auth/mfa/disable', { method: 'POST', body: { password, code } }),
    onSuccess: async () => {
      setMe(await api<MeDto>('/auth/me'));
      toast.success('Multi-factor authentication turned off.');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="flex items-center gap-2 text-sm">
        <ShieldCheck className="size-4 text-green-600" /> Your account is protected by an authenticator app.
      </p>
      <ErrorAlert error={mutation.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
        <Field label="Code or recovery code">{(id) => <Input id={id} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} required />}</Field>
      </div>
      <Button type="submit" variant="danger" loading={mutation.isPending}>
        Turn off MFA
      </Button>
    </form>
  );
}

export function ProfilePage() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Your profile" description="Account details, password and multi-factor authentication." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Account" />
          <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {[
              ['Name', me.displayName],
              ['Username', me.username],
              ['Email', me.email ?? '—'],
              ['Role', <Badge tone="indigo">{ROLE_LABELS[me.role]}</Badge>],
              ['Last sign-in', formatDateTime(me.lastLoginAt)],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-4 px-5 py-3">
                <dt className="text-slate-500 dark:text-slate-400">{k}</dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Multi-factor authentication" description="Require a one-time code from your phone in addition to your password." />
          <div className="p-5">{me.mfaEnabled ? <DisableMfa /> : <MfaSetup />}</div>
        </Card>

        <ApiTokensCard />

        <Card className="lg:col-span-2">
          <CardHeader title="Change password" description="Changing your password signs out all of your other sessions." />
          <div className="max-w-md p-5">
            <ChangePasswordForm />
          </div>
        </Card>
      </div>
    </>
  );
}
