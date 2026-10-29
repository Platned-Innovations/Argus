import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SCANNING_SETTINGS } from '@argus/shared';
import { nuspecLicense } from '../../src/scanning/parsers/nuget';
import { computeRisk } from '../../src/scanning/risk';
import { SecretsScanner } from '../../src/scanning/scanners/secrets';
import { awsSecretKeyNear, azureAccountNear, SecretVerifier } from '../../src/scanning/secret-verifier';
import { type ScanInput } from '../../src/scanning/types';

// Assembled at runtime so no literal looks like a real token to secret scanners.
const LIVE = ['ghp_', 'Live00000000000000000000000000000001'].join('');
const DEAD = ['ghp_', 'Dead00000000000000000000000000000002'].join('');
const AWS_ID = ['AKIA', 'ARGUSTESTKEY0001'].join('');
const AWS_SECRET = ['argus', 'Test/Secret+Key'.repeat(2), 'abcde'].join('');
const AZ_KEY = Buffer.alloc(64, 1).toString('base64');

/** Independent check of the Signature Version 4 request the verifier sends to STS. */
function awsSignatureValid(h: IncomingHttpHeaders, body: string, host: string): boolean {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=([0-9a-f]{64})$/.exec(h.authorization ?? '');
  if (!m || m[1] !== AWS_ID) return false;
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const mac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();
  const canonical = `POST\n/aws/\n\ncontent-type:${h['content-type']}\nhost:${host}\nx-amz-date:${h['x-amz-date']}\n\ncontent-type;host;x-amz-date\n${sha(body)}`;
  const toSign = `AWS4-HMAC-SHA256\n${h['x-amz-date']}\n${m[2]}/us-east-1/sts/aws4_request\n${sha(canonical)}`;
  const key = mac(mac(mac(mac(`AWS4${AWS_SECRET}`, m[2]), 'us-east-1'), 'sts'), 'aws4_request');
  return body === 'Action=GetCallerIdentity&Version=2011-06-15' && createHmac('sha256', key).update(toSign).digest('hex') === m[3];
}

/** Independent check of the Shared Key request the verifier sends to the blob service. */
function azureSignatureValid(h: IncomingHttpHeaders): boolean {
  const toSign = `GET\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:${h['x-ms-date']}\nx-ms-version:${h['x-ms-version']}\n/argusacct/\ncomp:properties\nrestype:service`;
  return h.authorization === `SharedKey argusacct:${createHmac('sha256', Buffer.from(AZ_KEY, 'base64')).update(toSign).digest('base64')}`;
}

describe('NuGet license data', () => {
  it('reads license expressions, maps well-known license URLs and ignores license files', () => {
    const nuspec = (meta: string) => `<?xml version="1.0"?><package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd"><metadata><id>X</id>${meta}</metadata></package>`;
    expect(nuspecLicense(nuspec('<license type="expression">MIT</license>'))).toBe('MIT');
    expect(nuspecLicense(nuspec('<license type="expression">Apache-2.0 OR MIT</license>'))).toBe('Apache-2.0 OR MIT');
    expect(nuspecLicense(nuspec('<license type="file">LICENSE.txt</license>'))).toBeNull();
    expect(nuspecLicense(nuspec('<licenseUrl>https://licenses.nuget.org/GPL-3.0-only</licenseUrl>'))).toBe('GPL-3.0-only');
    expect(nuspecLicense(nuspec('<licenseUrl>http://www.apache.org/licenses/LICENSE-2.0</licenseUrl>'))).toBe('Apache-2.0');
    expect(nuspecLicense(nuspec('<licenseUrl>https://example.com/eula</licenseUrl>'))).toBeNull();
    expect(nuspecLicense(nuspec(''))).toBeNull();
  });
});

describe('live secret verification', () => {
  let issuer: Server;
  const seen: { path: string; auth: string | undefined }[] = [];
  let verifier: SecretVerifier;

  beforeAll(async () => {
    issuer = createServer((req, res) => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization ?? (req.headers['private-token'] as string | undefined) });
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/gh/user') return req.headers.authorization === `token ${LIVE}` ? json(200, { login: 'x' }) : json(401, {});
      if (req.url === '/slack/api/auth.test') return json(200, req.headers.authorization === 'Bearer xoxb-live' ? { ok: true } : { ok: false, error: 'invalid_auth' });
      if (req.url === '/gl/api/v4/personal_access_tokens/self') return json(500, {});
      if (req.url === '/npm/-/whoami') return res.writeHead(302, { location: 'https://evil.example/' }).end();
      if (req.url === '/aws/' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          const ok = awsSignatureValid(req.headers, body, req.headers.host!);
          res.writeHead(ok ? 200 : 403).end(ok ? '<GetCallerIdentityResponse/>' : '<Error><Code>InvalidClientTokenId</Code></Error>');
        });
        return;
      }
      if (req.url === '/azure/argusacct/?restype=service&comp=properties') {
        return azureSignatureValid(req.headers) ? res.writeHead(200).end('<StorageServiceProperties/>') : res.writeHead(403, { 'x-ms-error-code': 'AuthenticationFailed' }).end();
      }
      if (req.url === '/azure/blocked/?restype=service&comp=properties') return res.writeHead(403, { 'x-ms-error-code': 'AuthorizationFailure' }).end();
      return json(404, {});
    });
    await new Promise<void>((r) => issuer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
    verifier = new SecretVerifier({ github: `${base}/gh`, gitlab: `${base}/gl`, slack: `${base}/slack`, npm: `${base}/npm`, aws: `${base}/aws`, azureBlob: `${base}/azure/{account}` });
  });

  it('checks AWS keys with STS and Azure Storage keys with the blob service, using the companion value in the same file', async () => {
    const awsFile = (secret: string) => `[default]\naws_access_key_id = ${AWS_ID}\naws_secret_access_key = ${secret}\n`;
    expect(awsSecretKeyNear(awsFile(AWS_SECRET))).toBe(AWS_SECRET);
    expect(awsSecretKeyNear(`${awsFile(AWS_SECRET)}\nsecret_key=${'B'.repeat(40)}`)).toBeNull();
    expect(await verifier.verify('aws-access-token', AWS_ID, awsFile(AWS_SECRET))).toEqual({ status: 'active', issuer: 'AWS' });
    expect(await verifier.verify('aws-access-token', AWS_ID, awsFile('C'.repeat(40)))).toEqual({ status: 'inactive', issuer: 'AWS' });
    // Without the secret key, or for temporary keys, nothing is sent.
    seen.length = 0;
    expect(await verifier.verify('aws-access-token', AWS_ID, 'no secret here')).toBeNull();
    expect(await verifier.verify('aws-access-token', `ASIA${AWS_ID.slice(4)}`, awsFile(AWS_SECRET))).toBeNull();
    expect(seen).toHaveLength(0);

    const cs = (account: string, key: string, extra = '') => `"Storage": "DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${key};${extra}"`;
    expect(azureAccountNear(cs('argusacct', AZ_KEY), AZ_KEY)).toBe('argusacct');
    expect(azureAccountNear(cs('argusacct', AZ_KEY, 'EndpointSuffix=core.chinacloudapi.cn'), AZ_KEY)).toBeNull();
    expect(await verifier.verify('azure-storage-account-key', AZ_KEY, cs('argusacct', AZ_KEY))).toEqual({ status: 'active', issuer: 'Azure Storage' });
    const wrong = Buffer.alloc(64, 7).toString('base64');
    expect(await verifier.verify('azure-storage-account-key', wrong, cs('argusacct', wrong))).toEqual({ status: 'inactive', issuer: 'Azure Storage' });
    // A storage firewall refusal says nothing about the key.
    expect(await verifier.verify('azure-storage-account-key', AZ_KEY, cs('blocked', AZ_KEY))).toEqual({ status: 'unknown', issuer: 'Azure Storage' });
  });
  afterAll(() => issuer.close());

  it('asks the issuer and maps its answer; anything unclear is inconclusive', async () => {
    expect(await verifier.verify('github-pat', LIVE)).toEqual({ status: 'active', issuer: 'GitHub' });
    expect(await verifier.verify('github-pat', DEAD)).toEqual({ status: 'inactive', issuer: 'GitHub' });
    expect(await verifier.verify('slack-bot-token', 'xoxb-live')).toEqual({ status: 'active', issuer: 'Slack' });
    expect(await verifier.verify('slack-token', 'xoxb-dead')).toEqual({ status: 'inactive', issuer: 'Slack' });
    expect(await verifier.verify('gitlab-pat', 'glpat-x')).toEqual({ status: 'unknown', issuer: 'GitLab' });
    // Redirects are refused, so a secret is never forwarded to another host.
    expect(await verifier.verify('npm-access-token', 'npm_x')).toEqual({ status: 'unknown', issuer: 'npm' });
    expect(await verifier.verify('aws-access-token', 'AKIA')).toBeNull();
    expect(verifier.supports('private-key')).toBe(false);
  });

  it('marks findings and adjusts their risk only when the setting is on', async () => {
    const input = (verifySecrets: boolean): ScanInput =>
      ({
        workdir: '/nonexistent',
        files: [{ path: 'src/a.js', abs: '/nonexistent/a.js', size: 100 }],
        repo: { id: 'r' },
        settings: { ...DEFAULT_SCANNING_SETTINGS, verifySecrets },
        log: () => undefined,
        hashSecret: (v: string) => `h(${v.length})`,
        readText: async () => `const a = "${LIVE}";\nconst b = "${DEAD}";\n`,
      }) as unknown as ScanInput;
    const scanner = new SecretsScanner('argus-no-such-gitleaks', 10_000, verifier);
    seen.length = 0;
    const off = await scanner.run(input(false));
    expect(seen).toHaveLength(0);
    expect(off.findings.every((f) => !f.details?.verification)).toBe(true);

    const on = await scanner.run(input(true));
    const [live, dead] = on.findings;
    expect(live.details).toMatchObject({ verification: { status: 'active', issuer: 'GitHub' } });
    expect(dead.details).toMatchObject({ verification: { status: 'inactive' } });
    expect(seen.map((s) => s.path)).toEqual(['/gh/user', '/gh/user']);
    const w = DEFAULT_SCANNING_SETTINGS.riskWeights;
    const liveRisk = computeRisk({ ...live.risk, publicRepo: false, criticality: 'medium' }, w);
    const deadRisk = computeRisk({ ...dead.risk, publicRepo: false, criticality: 'medium' }, w);
    expect(liveRisk.factors.map((x) => x.key)).toContain('verified_active');
    expect(deadRisk.factors.map((x) => x.key)).toContain('verified_inactive');
    expect(liveRisk.score - deadRisk.score).toBe(w.verifiedActive - w.verifiedInactive);
    // Values never end up in the finding.
    expect(JSON.stringify(on.findings)).not.toContain(LIVE);
  });
});
