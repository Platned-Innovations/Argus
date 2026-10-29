import 'reflect-metadata';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { type RepositoryDto, type ScanRunDto, type SourceDto } from '@argus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { AppConfig } from '../../src/config/app-config';
import { BASE_TEST_ENV, Client, dbHarnesses, waitFor } from './helpers';
import { createGitRepo, type FixtureRepo, type MockGitHub, startMockGitHub } from './mock-github';

const APP_ID = '424242';
const INSTALLATION_ID = 77;
const harnesses = dbHarnesses();

describe.each(harnesses)('GitHub App sources e2e: $name', (h) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  // A distinct installation token per database run, so the cached token of one run is not reused by the next.
  const installationToken = `ghs_${h.name}InstallationToken0123456789`;
  const calls = { jwt: 0, tokens: 0 };
  let app: INestApplication;
  let admin: Client;
  let mock: MockGitHub;
  let fixture: FixtureRepo;
  let tmp: string;

  /** The App API: only accepts a JWT signed with the app's key, issued by this app and not expired. */
  const jwtValid = (auth: string | undefined) => {
    const [h64, p64, sig] = (auth ?? '').replace(/^Bearer /, '').split('.');
    if (!h64 || !p64 || !sig) return false;
    const claims = JSON.parse(Buffer.from(p64, 'base64url').toString()) as { iss: string; iat: number; exp: number };
    const now = Date.now() / 1000;
    return verify('RSA-SHA256', Buffer.from(`${h64}.${p64}`), publicKey, Buffer.from(sig, 'base64url')) && claims.iss === APP_ID && claims.exp > now && claims.exp - claims.iat <= 600;
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'argus-ghapp-'));
    fixture = createGitRepo(tmp, { 'package.json': JSON.stringify({ name: 'fixture', dependencies: { lodash: '4.17.20' } }) });
    mock = await startMockGitHub({
      bare: fixture.bare,
      token: installationToken,
      repos: [
        { id: 901, name: 'payments' },
        { id: 902, name: 'ledger' },
      ],
      extra: (req, url, _body, res) => {
        const json = (status: number, data: unknown) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
        const appRoute = url.pathname === '/api/v3/app' || /^\/api\/v3\/(orgs|users)\/[^/]+\/installation$/.test(url.pathname) || url.pathname.startsWith('/api/v3/app/installations/');
        if (!appRoute) return false;
        calls.jwt++;
        if (!jwtValid(req.headers.authorization)) return (json(401, { message: 'A JSON web token could not be decoded' }), true);
        if (url.pathname === '/api/v3/app') return (json(200, { slug: 'argus-scanner' }), true);
        if (url.pathname === '/api/v3/orgs/acme/installation') return (json(200, { id: INSTALLATION_ID }), true);
        if (url.pathname === `/api/v3/app/installations/${INSTALLATION_ID}/access_tokens` && req.method === 'POST') {
          calls.tokens++;
          return (json(201, { token: installationToken, expires_at: new Date(Date.now() + 3_600_000).toISOString() }), true);
        }
        return (json(404, { message: 'Not Found' }), true);
      },
    });
    const env = await h.env();
    app = await createApiApp(
      AppConfig.fromEnv({ ...env, ...BASE_TEST_ENV, ARGUS_ADMIN_PASSWORD: 'Initial-Admin-Pass-1', ARGUS_ROLE: 'all', ARGUS_SCAN_WORKDIR: join(tmp, 'scans'), ARGUS_SCHEDULER_INTERVAL_SECONDS: '1', ARGUS_OFFLINE: 'true', ARGUS_GITLEAKS_PATH: 'argus-test-no-gitleaks' }),
    );
    await app.init();
    admin = new Client(app);
    await admin.login('admin', 'Initial-Admin-Pass-1');
    await admin.call('post', '/api/v1/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'Second-Root-Pass-9' });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    mock?.server.close();
    await h.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('validates GitHub App settings before calling GitHub', async () => {
    const base = { provider: 'github', baseUrl: mock.baseUrl, scope: 'acme', username: APP_ID, token: pem };
    expect((await admin.call('post', '/api/v1/sources/test', { ...base, username: 'my-app' })).status).toBe(400);
    expect((await admin.call('post', '/api/v1/sources/test', { ...base, scope: null })).status).toBe(400);
    expect((await admin.call('post', '/api/v1/sources/test', { ...base, token: 'ghp_notakey' })).status).toBe(400);
    const notInstalled = await admin.call('post', '/api/v1/sources/test', { ...base, scope: 'other-org' });
    expect(notInstalled.body).toMatchObject({ ok: false, message: expect.stringMatching(/not installed on other-org/) });
    const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongKey = await admin.call('post', '/api/v1/sources/test', { ...base, token: otherKey.export({ type: 'pkcs1', format: 'pem' }).toString() });
    expect(wrongKey.body).toMatchObject({ ok: false, message: expect.stringMatching(/rejected the credentials/) });
    const ok = await admin.call('post', '/api/v1/sources/test', base);
    expect(ok.body).toMatchObject({ ok: true, identity: 'argus-scanner (GitHub App)', visibleRepos: 2 });
  });

  it('syncs the installation repositories and clones with a short-lived installation token', async () => {
    const created = await admin.call('post', '/api/v1/sources', { name: 'Acme app', provider: 'github', baseUrl: mock.baseUrl, scope: 'acme', username: APP_ID, token: pem, autoActivatePattern: 'acme/payments' });
    expect(created.status).toBe(201);
    expect(created.body.source).toMatchObject({ authMethod: 'github_app', tokenHint: 'private key', username: APP_ID });
    expect(JSON.stringify(created.body)).not.toContain('PRIVATE KEY');

    const source = await waitFor(
      async () => {
        const s = ((await admin.call('get', '/api/v1/sources')).body as SourceDto[]).find((x) => x.id === created.body.source.id);
        return s?.status === 'ok' ? s : null;
      },
      { what: 'GitHub App source sync' },
    );
    expect(source).toMatchObject({ repoCount: 2, activeRepoCount: 1 });

    const repo = ((await admin.call('get', `/api/v1/repos?sourceId=${source.id}`)).body.items as RepositoryDto[]).find((r) => r.name === 'payments')!;
    const run = await waitFor(
      async () => {
        const runs = (await admin.call('get', `/api/v1/repos/${repo.id}/scans`)).body.items as ScanRunDto[];
        return runs.find((r) => r.status === 'succeeded' || r.status === 'failed') ?? null;
      },
      { what: 'scan with an installation token', timeoutMs: 60_000 },
    );
    expect(run.status).toBe('succeeded');
    expect(run.commitSha).toBe(fixture.sha);
    expect(mock.gitAuthHeaders.at(-1)).toBe(`Basic ${Buffer.from(`x-access-token:${installationToken}`).toString('base64')}`);
    // Installation tokens are reused while valid rather than minted for every call.
    expect(calls.tokens).toBeLessThanOrEqual(2);
    const log = (await admin.call('get', `/api/v1/scans/${run.id}`)).body.log as string[];
    expect(log.join('\n')).not.toContain(installationToken);
  });
});
