import { SIGN_IN_LINK_MINUTES, type SignInOptionsDto } from '@argus/shared';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Mail, MailCheck } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Button, Card, CenteredSpinner, ErrorAlert, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useBranding } from '../lib/branding';

/** Emailed sign-in links point to /login#link=<token>: the fragment never reaches the server or its logs. */
const LINK_PREFIX = '#link=';

type Step = 'password' | 'link' | 'link-sent' | 'link-signing-in';

export function LoginPage() {
  const branding = useBranding();
  const { me, login, verifyMfa, signInWithLink } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState<Step>(() => (location.hash.startsWith(LINK_PREFIX) ? 'link-signing-in' : 'password'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const options = useQuery({ queryKey: ['auth', 'options'], queryFn: () => api<SignInOptionsDto>('/auth/options'), staleTime: 60_000 });
  /** The token already used, so a re-render or React's double mount in development cannot use it twice. */
  const linkHandled = useRef<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

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

  // Opening an emailed link: use its token once, and take it out of the address bar and history straight away.
  // Also handles a link pasted into a tab already showing this page (only the fragment changes then).
  useEffect(() => {
    if (!location.hash.startsWith(LINK_PREFIX)) return;
    const token = location.hash.slice(LINK_PREFIX.length);
    if (linkHandled.current === token) return;
    linkHandled.current = token;
    setStep('link-signing-in');
    navigate('/login', { replace: true, state: location.state });
    void run(async () => {
      try {
        const res = await signInWithLink(token);
        if (res.status === 'mfa_required') {
          setMfaToken(res.mfaToken);
          setStep('password');
        } else navigate(from, { replace: true });
      } catch (err) {
        setStep('password');
        throw err;
      }
    });
  }, [location.hash]);

  if (me) return <Navigate to={from} replace />;

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

  const requestLink = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/auth/sign-in-link', { method: 'POST', body: { login: username } });
      setStep('link-sent');
    });
  };

  const backToPassword = () => {
    setStep('password');
    setMfaToken(null);
    setCode('');
    setError(null);
  };

  const linkButton = options.data?.signInLinks && (
    <button type="button" onClick={() => (setStep('link'), setError(null))} className="flex w-full items-center justify-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
      <Mail className="size-4" /> Email me a sign-in link
    </button>
  );

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="size-12" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Sign in to {branding.productName}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Continuous security & dependency monitoring</p>
        </div>
        <Card className="p-6">
          {mfaToken ? (
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
              <button type="button" className="w-full text-center text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300" onClick={backToPassword}>
                Back to sign in
              </button>
            </form>
          ) : step === 'link-signing-in' ? (
            <div className="space-y-3 text-center text-sm text-slate-500">
              <CenteredSpinner />
              Signing you in…
            </div>
          ) : step === 'link' ? (
            <form onSubmit={requestLink} className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Mail className="size-4 text-indigo-600" /> Sign in with an email link
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">We will email a link that signs you in. It works once and expires in {SIGN_IN_LINK_MINUTES} minutes.</p>
              <ErrorAlert error={error} />
              <Field label="Username or email">{(id) => <Input id={id} autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />}</Field>
              <Button type="submit" className="w-full" loading={busy}>
                Email me a link
              </Button>
              <button type="button" className="w-full text-center text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300" onClick={backToPassword}>
                Sign in with password instead
              </button>
            </form>
          ) : step === 'link-sent' ? (
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <MailCheck className="size-4 text-green-600" /> Check your inbox
              </div>
              <p className="text-slate-600 dark:text-slate-300">
                If <strong>{username}</strong> has an account with an email address, a sign-in link is on its way. It expires in {SIGN_IN_LINK_MINUTES} minutes. Didn&apos;t get it? Check your spam folder, or ask again
                in a minute.
              </p>
              <button type="button" className="w-full text-center text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300" onClick={backToPassword}>
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={submitPassword} className="space-y-4">
              <ErrorAlert error={error} />
              <Field label="Username or email">
                {(id) => <Input id={id} autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />}
              </Field>
              <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
              <Button type="submit" className="w-full" loading={busy}>
                Sign in
              </Button>
              {linkButton && (
                <>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                    or
                    <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                  </div>
                  {linkButton}
                </>
              )}
            </form>
          )}
        </Card>
        {branding.loginNotice && <p className="mt-6 text-center text-xs whitespace-pre-line text-slate-500 dark:text-slate-400">{branding.loginNotice}</p>}
      </div>
    </div>
  );
}
