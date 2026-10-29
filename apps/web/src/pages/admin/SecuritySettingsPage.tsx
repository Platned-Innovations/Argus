import { type SecuritySettings } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardHeader, CenteredSpinner, Checkbox, ErrorAlert, Field, Input, PageHeader } from '../../components/ui';
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
