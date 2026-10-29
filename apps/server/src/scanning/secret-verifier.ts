import { createHash, createHmac } from 'node:crypto';

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
  aws: string;
  /** "{account}" is replaced with the storage account name. */
  azureBlob: string;
}

export const ISSUER_ENDPOINTS: VerifierEndpoints = {
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com',
  slack: 'https://slack.com',
  npm: 'https://registry.npmjs.org',
  aws: 'https://sts.amazonaws.com',
  azureBlob: 'https://{account}.blob.core.windows.net',
};

const TIMEOUT_MS = 10_000;

interface Check {
  issuer: string;
  /**
   * One read-only request that only succeeds with a valid credential, or null when it cannot be checked (some
   * credentials only work with a companion value, such as the AWS secret key, found in the same file).
   */
  request(e: VerifierEndpoints, value: string, context: string): { url: string; init: RequestInit } | null;
  /** Interprets the response; anything not clearly valid or clearly invalid is "unknown". */
  verdict(res: Response): Promise<VerificationStatus>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();

/** The AWS secret access key next to an access key ID, if the file has exactly one candidate. */
export function awsSecretKeyNear(context: string): string | null {
  const found = new Set<string>();
  for (const m of context.matchAll(/(?:aws)?_?secret_?(?:access)?_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi)) found.add(m[1]);
  return found.size === 1 ? [...found][0] : null;
}

/**
 * sts:GetCallerIdentity, signed with Signature Version 4. It needs no IAM permission, changes nothing and only
 * tells who the key belongs to.
 */
function awsRequest(endpoint: string, keyId: string, secret: string, now = new Date()): { url: string; init: RequestInit } {
  const url = new URL(`${endpoint}/`);
  const body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/us-east-1/sts/aws4_request`;
  const contentType = 'application/x-www-form-urlencoded; charset=utf-8';
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonical = ['POST', url.pathname, '', `content-type:${contentType}`, `host:${url.host}`, `x-amz-date:${amzDate}`, '', signedHeaders, sha256(body)].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), 'us-east-1'), 'sts'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    url: url.toString(),
    init: {
      method: 'POST',
      body,
      headers: {
        'Content-Type': contentType,
        'X-Amz-Date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    },
  };
}

/** The storage account of an account key, from the connection string it is in (public Azure cloud only). */
export function azureAccountNear(context: string, key: string): string | null {
  for (const cs of context.split(/["'\n]/)) {
    if (!cs.includes(`AccountKey=${key}`)) continue;
    const account = /(?:^|;)\s*AccountName=([a-z0-9]{3,24})\s*(?:;|$)/.exec(cs)?.[1];
    const suffix = /(?:^|;)\s*EndpointSuffix=([^;\s]+)/i.exec(cs)?.[1];
    if (account && (!suffix || suffix.toLowerCase() === 'core.windows.net')) return account;
  }
  return null;
}

/** "Get Blob Service Properties", signed with the account key (Shared Key). It reads service settings only, no data. */
function azureRequest(endpointTemplate: string, account: string, key: string, now = new Date()): { url: string; init: RequestInit } {
  const url = `${endpointTemplate.replace('{account}', account)}/?restype=service&comp=properties`;
  const date = now.toUTCString();
  const version = '2021-08-06';
  const toSign = ['GET', '', '', '', '', '', '', '', '', '', '', '', `x-ms-date:${date}`, `x-ms-version:${version}`, `/${account}/`, 'comp:properties', 'restype:service'].join('\n');
  const signature = createHmac('sha256', Buffer.from(key, 'base64')).update(toSign, 'utf8').digest('base64');
  return { url, init: { headers: { 'x-ms-date': date, 'x-ms-version': version, Authorization: `SharedKey ${account}:${signature}` } } };
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
  'aws-access-token': {
    issuer: 'AWS',
    // Temporary (ASIA…) keys also need a session token, so only long-term AKIA keys can be checked.
    request: (e, v, context) => {
      const secret = v.startsWith('AKIA') ? awsSecretKeyNear(context) : null;
      return secret ? awsRequest(e.aws, v, secret) : null;
    },
    verdict: async (res) => {
      if (res.status === 200) return 'active';
      const body = await res.text().catch(() => '');
      return res.status === 403 && /InvalidClientTokenId|SignatureDoesNotMatch/.test(body) ? 'inactive' : 'unknown';
    },
  },
  'azure-storage-account-key': {
    issuer: 'Azure Storage',
    request: (e, v, context) => {
      const account = azureAccountNear(context, v);
      return account ? azureRequest(e.azureBlob, account, v) : null;
    },
    verdict: async (res) => {
      if (res.status === 200) return 'active';
      // A request from an IP the storage firewall blocks is also 403, but with a different error code.
      return res.status === 403 && res.headers.get('x-ms-error-code') === 'AuthenticationFailed' ? 'inactive' : 'unknown';
    },
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

  /** `context` is the text of the file the secret is in, for credentials that need a companion value. */
  async verify(ruleId: string, value: string, context = ''): Promise<VerificationResult | null> {
    const check = CHECKS[ruleId];
    if (!check) return null;
    const req = check.request(this.endpoints, value, context);
    if (!req) return null;
    const { url, init } = req;
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
