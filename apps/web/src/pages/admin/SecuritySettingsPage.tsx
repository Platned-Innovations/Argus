import { type ChannelDto, isEmailChannel, type SecuritySettings, SIGN_IN_LINK_MINUTES } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardHeader, CenteredSpinner, Checkbox, ErrorAlert, Field, Input, PageHeader, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ApiTokensCard } from '../../components/ApiTokens';

const numberFields: { key: keyof SecuritySettings; label: string; hint: string; min: number; max: number; group: 'password' | 'session' }[] = [
  { key: 'passwordMinLength', label: 'Minimum password length', hint: '8–128 characters.', min: 8, max: 128, group: 'password' },
  { key: 'passwordRequiredClasses', label: 'Required character classes', hint: 'Out of lowercase, uppercase, digit, symbol (1–4).', min: 1, max: 4, group: 'password' },
  { key: 'lockoutThreshold', label: 'Lock after failed attempts', hint: 'Consecutive failures before the account is locked.', min: 3, max: 50, group: 'password' },
  { key: 'lockoutMinutes', label: 'Lockout duration (minutes)', hint: 'Administrators can unlock accounts earlier.', min: 1, max: 1440, group: 'password' },
  { key: 'accessTokenMinutes', label: 'Access token lifetime (minutes)', hint: 'Short-lived; refreshed silently while the session is active.', min: 5, max: 60, group: 'session' },
  { key: 'sessionDays', label: 'Session lifetime (days of inactivity)', hint: 'Users must sign in again after this long without activity.', min: 1, max: 90, group: 'session' },
];

export function SecuritySettingsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('settings:manage');
  const query = useQuery({ queryKey: ['settings', 'security'], queryFn: () => api<SecuritySettings>('/settings/security') });
  const channels = useQuery({ queryKey: ['integrations', 'channels'], queryFn: () => api<ChannelDto[]>('/integrations/channels'), enabled: manage });
  const emailChannels = (channels.data ?? []).filter((c) => isEmailChannel(c.type));
  const [form, setForm] = useState<SecuritySettings | null>(null);
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: SecuritySettings) => api<SecuritySettings>('/settings/security', { method: 'PUT', body }),
    onSuccess: (data) => {
      qc.setQueryData(['settings', 'security'], data);
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast.success('Security settings saved.');
    },
  });

  if (query.isLoading || !form) return <CenteredSpinner />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(form);
  };
  const renderGroup = (group: 'password' | 'session') => (
    <div className="grid gap-4 p-5 sm:grid-cols-2">
      {numberFields
        .filter((f) => f.group === group)
        .map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {(id) => <Input id={id} type="number" min={f.min} max={f.max} value={form[f.key] as number} onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })} required />}
          </Field>
        ))}
    </div>
  );

  return (
    <>
      <PageHeader title="Security settings" description="Authentication policy for every Argus account." />
      <form onSubmit={submit} className="space-y-6">
        <ErrorAlert error={query.error ?? save.error} />
        <fieldset disabled={!manage} className="space-y-6">
          <Card>
            <CardHeader title="Multi-factor authentication" />
            <div className="p-5">
              <Checkbox
                label="Require MFA for all users"
                description="Users without an authenticator will be asked to set one up at their next sign-in before they can do anything else."
                checked={form.mfaRequired}
                onChange={(e) => setForm({ ...form, mfaRequired: e.target.checked })}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Sign-in links by email" description="Lets users sign in with a one-time link sent to their email address, for example when they have forgotten their password." />
            <div className="space-y-4 p-5">
              <Checkbox
                label="Allow sign-in links"
                description={`The sign-in page offers "Email me a sign-in link". Each link works once and expires after ${SIGN_IN_LINK_MINUTES} minutes. Users with MFA still enter their code, and only users with an email address can use it. Needs ARGUS_PUBLIC_URL to be set.`}
                checked={form.signInLinks}
                onChange={(e) => setForm({ ...form, signInLinks: e.target.checked, signInLinkChannelId: form.signInLinkChannelId ?? emailChannels[0]?.id ?? null })}
              />
              {form.signInLinks &&
                (emailChannels.length ? (
                  <div className="max-w-sm">
                    <Field label="Send links with" hint="An email channel from Integrations.">
                      {(id) => (
                        <Select id={id} value={form.signInLinkChannelId ?? ''} onChange={(e) => setForm({ ...form, signInLinkChannelId: e.target.value || null })} required>
                          <option value="">Choose a channel</option>
                          {emailChannels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                              {c.enabled ? '' : ' (disabled)'}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                ) : (
                  <p className="text-sm text-amber-700 dark:text-amber-400">Set up an email channel under Integrations first; sign-in links are sent through it.</p>
                ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Passwords & lockout" description="Passwords are hashed with argon2id. Changes apply to the next password set." />
            {renderGroup('password')}
          </Card>
          <Card>
            <CardHeader title="Sessions" />
            {renderGroup('session')}
          </Card>
        </fieldset>
        {manage && (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              Save settings
            </Button>
          </div>
        )}
      </form>
      {can('users:manage') && (
        <div className="mt-6">
          <ApiTokensCard all />
        </div>
      )}
    </>
  );
}
