import { type MeDto, type MfaEnableResponse, type MfaSetupResponse } from '@argus/shared';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SecretReveal } from './SecretReveal';
import { Button, ErrorAlert, Field, Input } from './ui';

/** Three steps: generate secret → confirm a code → show recovery codes once. */
export function MfaSetup({ onDone }: { onDone?(): void }) {
  const { setMe } = useAuth();
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const start = useMutation({ mutationFn: () => api<MfaSetupResponse>('/auth/mfa/setup', { method: 'POST' }), onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => api<MfaEnableResponse>('/auth/mfa/enable', { method: 'POST', body: { code } }),
    onSuccess: (res) => setRecovery(res.recoveryCodes),
  });

  const finish = async () => {
    setMe(await api<MeDto>('/auth/me'));
    toast.success('Multi-factor authentication is on.');
    onDone?.();
  };

  if (recovery) {
    return (
      <div className="space-y-4">
        <p className="text-sm">
          Save these recovery codes somewhere safe. Each one can be used <strong>once</strong> if you lose your authenticator. They will not be shown again.
        </p>
        <SecretReveal value={recovery.join('\n')} multiline />
        <Button onClick={finish} icon={<ShieldCheck className="size-4" />}>
          I have saved my recovery codes
        </Button>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="space-y-4">
        <ErrorAlert error={start.error} />
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Use an authenticator app such as Microsoft Authenticator, Google Authenticator or 1Password to generate one-time codes when you sign in.
        </p>
        <Button onClick={() => start.mutate()} loading={start.isPending}>
          Set up authenticator
        </Button>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    enable.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorAlert error={enable.error} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <img src={setup.qrDataUrl} alt="QR code for your authenticator app" className="size-44 rounded-md bg-white p-1 ring-1 ring-slate-200" />
        <div className="min-w-0 space-y-2 text-sm">
          <p>1. Scan the QR code with your authenticator app.</p>
          <p className="text-slate-500 dark:text-slate-400">Can't scan? Enter this key manually:</p>
          <SecretReveal value={setup.secret} />
        </div>
      </div>
      <Field label="2. Enter the 6-digit code from the app">
        {(id) => (
          <Input id={id} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="max-w-40 font-mono tracking-widest" required />
        )}
      </Field>
      <Button type="submit" loading={enable.isPending} disabled={code.length !== 6}>
        Verify and enable
      </Button>
    </form>
  );
}
