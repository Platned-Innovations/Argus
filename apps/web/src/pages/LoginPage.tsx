import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Button, Card, ErrorAlert, Field, Input } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useBranding } from '../lib/branding';

export function LoginPage() {
  const branding = useBranding();
  const { me, login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (me) return <Navigate to={from} replace />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await login(username, password);
      if (res.status === 'mfa_required') setMfaToken(res.mfaToken);
      else navigate(from, { replace: true });
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await verifyMfa(mfaToken!, code);
      navigate(from, { replace: true });
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="size-12" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Sign in to {branding.productName}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Continuous security & dependency monitoring</p>
        </div>
        <Card className="p-6">
          {!mfaToken ? (
            <form onSubmit={submitPassword} className="space-y-4">
              <ErrorAlert error={error} />
              <Field label="Username or email">
                {(id) => <Input id={id} autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />}
              </Field>
              <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
              <Button type="submit" className="w-full" loading={busy}>
                Sign in
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="size-4 text-indigo-600" /> Two-step verification
              </div>
              <ErrorAlert error={error} />
              <Field label="Authentication code" hint="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
                {(id) => <Input id={id} autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.trim())} className="font-mono tracking-widest" required />}
              </Field>
              <Button type="submit" className="w-full" loading={busy}>
                Verify
              </Button>
              <button
                type="button"
                className="w-full text-center text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                onClick={() => {
                  setMfaToken(null);
                  setCode('');
                  setError(null);
                }}
              >
                Back to sign in
              </button>
            </form>
          )}
        </Card>
        {branding.loginNotice && <p className="mt-6 text-center text-xs whitespace-pre-line text-slate-500 dark:text-slate-400">{branding.loginNotice}</p>}
      </div>
    </div>
  );
}
