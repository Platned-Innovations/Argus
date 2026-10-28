import { checkPasswordPolicy, type MeDto } from '@argus/shared';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorAlert, Field, Input } from './ui';

export function ChangePasswordForm({ onDone }: { onDone?(): void }) {
  const { me, setMe } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const policyErrors = next ? checkPasswordPolicy(next, me!.passwordPolicy, { username: me!.username }) : [];
  const mismatch = confirm.length > 0 && confirm !== next;

  const mutation = useMutation({
    mutationFn: () => api<MeDto>('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } }),
    onSuccess: (updated) => {
      setMe(updated);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Password changed. Other sessions were signed out.');
      onDone?.();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!policyErrors.length && !mismatch) mutation.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorAlert error={mutation.error} />
      <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}</Field>
      <Field
        label="New password"
        error={policyErrors[0]}
        hint={`At least ${me!.passwordPolicy.minLength} characters with ${me!.passwordPolicy.requiredClasses} of: lowercase, uppercase, digit, symbol.`}
      >
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />}
      </Field>
      <Field label="Confirm new password" error={mismatch ? 'Passwords do not match.' : undefined}>
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
      </Field>
      <Button type="submit" loading={mutation.isPending} disabled={!current || !next || policyErrors.length > 0 || confirm !== next}>
        Change password
      </Button>
    </form>
  );
}
