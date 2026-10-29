import { LogOut } from 'lucide-react';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { MfaSetup } from '../components/MfaSetup';
import { Button, Card, CardHeader } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useBranding } from '../lib/branding';

/** Shown instead of the app while the account must change its password or enroll in MFA. */
export function RequiredSetupPage() {
  const { productName } = useBranding();
  const { me, logout } = useAuth();
  if (!me) return null;
  const needsPassword = me.restrictions.passwordChangeRequired;

  return (
    <div className="flex min-h-screen items-start justify-center px-4 py-16">
      <div className="w-full max-w-lg space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="size-8" />
            <span className="font-semibold">{productName}</span>
          </div>
          <Button variant="ghost" size="sm" icon={<LogOut className="size-4" />} onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
        <Card>
          {needsPassword ? (
            <>
              <CardHeader
                title="Choose a new password"
                description={`Welcome, ${me.displayName}. Your password was set by an administrator, so you need to choose your own before continuing.`}
              />
              <div className="p-5">
                <ChangePasswordForm />
              </div>
            </>
          ) : (
            <>
              <CardHeader title="Set up multi-factor authentication" description="Your organisation requires a second factor for every account." />
              <div className="p-5">
                <MfaSetup />
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
