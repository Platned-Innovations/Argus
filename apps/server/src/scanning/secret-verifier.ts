export type VerificationStatus = 'active' | 'inactive' | 'unknown';

export interface VerificationResult {
  status: VerificationStatus;
  issuer: string;
}

/** Official API endpoints of each issuer. Overridable for tests only (not configurable at runtime). */
export interface VerifierEndpoints {
  github: string;
  gitlab: string;
  slack: string;
  npm: string;
}

export const ISSUER_ENDPOINTS: VerifierEndpoints = {
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com',
  slack: 'https://slack.com',
  npm: 'https://registry.npmjs.org',
};

const TIMEOUT_MS = 10_000;

interface Check {
  issuer: string;
  /** One read-only request that only succeeds with a valid credential. */
  request(e: VerifierEndpoints, value: string): { url: string; init: RequestInit };
  /** Interprets the response; anything not clearly valid or clearly invalid is "unknown". */
  verdict(res: Response): Promise<VerificationStatus>;
}

const byStatus = async (res: Response): Promise<VerificationStatus> => (res.status === 200 ? 'active' : res.status === 401 || res.status === 403 ? 'inactive' : 'unknown');

const GITHUB: Check = {
  issuer: 'GitHub',
  request: (e, v) => ({ url: `${e.github}/user`, init: { headers: { Authorization: `token ${v}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Argus' } } }),
  verdict: async (res) => (res.status === 200 ? 'active' : res.status === 401 ? 'inactive' : 'unknown'),
};

/** Detector rule ids (built-in and Gitleaks) → how to check them with their issuer. */
const CHECKS: Record<string, Check> = {
  'github-pat': GITHUB,
  'github-fine-grained-pat': GITHUB,
  'github-oauth': GITHUB,
  'github-app-token': GITHUB,
  'gitlab-pat': {
    issuer: 'GitLab',
    request: (e, v) => ({ url: `${e.gitlab}/api/v4/personal_access_tokens/self`, init: { headers: { 'PRIVATE-TOKEN': v } } }),
    verdict: byStatus,
  },
  'slack-token': {
    issuer: 'Slack',
    request: (e, v) => ({ url: `${e.slack}/api/auth.test`, init: { method: 'POST', headers: { Authorization: `Bearer ${v}` } } }),
    verdict: async (res) => {
      if (res.status !== 200) return 'unknown';
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (body.ok) return 'active';
      return ['invalid_auth', 'token_revoked', 'account_inactive', 'token_expired', 'not_authed'].includes(body.error ?? '') ? 'inactive' : 'unknown';
    },
  },
  'npm-access-token': {
    issuer: 'npm',
    request: (e, v) => ({ url: `${e.npm}/-/whoami`, init: { headers: { Authorization: `Bearer ${v}` } } }),
    verdict: byStatus,
  },
};
for (const id of ['slack-bot-token', 'slack-user-token', 'slack-app-token', 'slack-legacy-token']) CHECKS[id] = CHECKS['slack-token'];

/**
 * Opt-in live verification of detected secrets: one read-only request to the secret's own issuer, which tells
 * whether the secret still works. The value goes only to the issuer's official API, never anywhere else, and is
 * never logged. Redirects are refused, so it cannot be bounced to another host.
 */
export class SecretVerifier {
  constructor(private readonly endpoints: VerifierEndpoints = ISSUER_ENDPOINTS) {}

  supports(ruleId: string): boolean {
    return ruleId in CHECKS;
  }

  async verify(ruleId: string, value: string): Promise<VerificationResult | null> {
    const check = CHECKS[ruleId];
    if (!check) return null;
    const { url, init } = check.request(this.endpoints, value);
    try {
      const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const status = await check.verdict(res);
      await res.body?.cancel().catch(() => undefined);
      return { status, issuer: check.issuer };
    } catch {
      return { status: 'unknown', issuer: check.issuer };
    }
  }
}
