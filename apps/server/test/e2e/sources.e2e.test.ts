import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { type RepositoryDto, type ScanRunDto, type SourceDto } from '@argus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { AppConfig } from '../../src/config/app-config';
import { BASE_TEST_ENV, Client, dbHarnesses, waitFor } from './helpers';

const TOKEN = 'ghp_e2eTestToken0123456789';
const EXPECTED_GIT_AUTH = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;

/** A git repository with an npm manifest, a .NET project and a certificate, served over git's "dumb" HTTP protocol. */
function createFixtureRepo(root: string): { bare: string; sha: string } {
  const work = join(root, 'work');
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(work, 'certs'));
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { lodash: '4.17.20' } }));
  writeFileSync(join(work, 'src', 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>');
  writeFileSync(join(work, 'certs', 'server.pem'), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  writeFileSync(join(work, 'README.md'), '# fixture\n');
  const git = (args: string[], cwd = work) => execFileSync('git', ['-c', 'user.name=Argus Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
  git(['init', '-q', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  const sha = git(['rev-parse', 'HEAD']);
  const bare = join(root, 'bare.git');
  git(['clone', '-q', '--bare', work, bare], root);
  git(['update-server-info'], bare);
  return { bare, sha };
}

interface MockGitHub {
  server: Server;
  baseUrl: string;
  gitAuthHeaders: string[];
}

/** Just enough of the GitHub Enterprise REST API, plus static git files for every acme/*.git clone URL. */
async function startMockGitHub(bare: string): Promise<MockGitHub> {
  const gitAuthHeaders: string[] = [];
  const state = { baseUrl: '' };
  const repo = (id: number, name: string, cloneUrl = `${state.baseUrl}/acme/${name}.git`) => ({
    id,
    full_name: `acme/${name}`,
    name,
    owner: { login: 'acme' },
    html_url: `${state.baseUrl}/acme/${name}`,
    clone_url: cloneUrl,
    default_branch: 'main',
    private: true,
    language: 'TypeScript',
    description: `${name} service`,
    archived: false,
    pushed_at: '2026-10-01T00:00:00Z',
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', state.baseUrl);
    if (url.pathname.startsWith('/api/v3/')) {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Bad credentials"}');
        return;
      }
      const json = (body: unknown, headers: Record<string, string> = {}) => res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
      if (url.pathname === '/api/v3/user') return json({ login: 'argus-bot' });
      if (url.pathname === '/api/v3/orgs/acme/repos') {
        if (url.searchParams.get('per_page') === '1') return json([repo(101, 'app-one')]);
        if (url.searchParams.get('page') === '2') return json([repo(103, 'lib-three'), repo(104, 'evil', 'https://evil.invalid/acme/evil.git')]);
        return json([repo(101, 'app-one'), repo(102, 'app-two')], { link: `<${state.baseUrl}/api/v3/orgs/acme/repos?per_page=100&page=2>; rel="next"` });
      }
      res.writeHead(404).end();
      return;
    }
    const m = /^\/acme\/[\w-]+\.git\/(.+)$/.exec(url.pathname);
    if (m) {
      gitAuthHeaders.push(req.headers.authorization ?? '');
      if (req.headers.authorization !== EXPECTED_GIT_AUTH) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end();
        return;
      }
      const file = normalize(join(bare, m[1]));
      if (!file.startsWith(normalize(bare)) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(file));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, baseUrl: state.baseUrl, gitAuthHeaders };
}

const harnesses = dbHarnesses();

describe.each(harnesses)('sources, repositories & scans e2e: $name', (h) => {
  let app: INestApplication;
  let admin: Client;
  let mock: MockGitHub;
  let fixture: { bare: string; sha: string };
  let tmp: string;
  let scanWorkdir: string;
  let source: SourceDto;
  let webhookSecret = '';
  let teamId = '';
  const repoByName = new Map<string, RepositoryDto>();

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'argus-e2e-'));
    scanWorkdir = join(tmp, 'scans');
    fixture = createFixtureRepo(tmp);
    mock = await startMockGitHub(fixture.bare);
    const env = await h.env();
    app = await createApiApp(
      AppConfig.fromEnv({ ...env, ...BASE_TEST_ENV, ARGUS_ADMIN_PASSWORD: 'Initial-Admin-Pass-1', ARGUS_ROLE: 'all', ARGUS_SCAN_WORKDIR: scanWorkdir, ARGUS_SCHEDULER_INTERVAL_SECONDS: '1' }),
    );
    await app.init();
    admin = new Client(app);
    await admin.login('admin', 'Initial-Admin-Pass-1');
    await admin.call('post', '/api/v1/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'Second-Root-Pass-9' });
    teamId = (await admin.call('post', '/api/v1/teams', { name: 'Payments' })).body.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    mock?.server.close();
    await h.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('tests connections without saving and rejects bad credentials', async () => {
    const bad = await admin.call('post', '/api/v1/sources/test', { provider: 'github', baseUrl: mock.baseUrl, scope: 'acme', token: 'wrong-token' });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false });
    expect(bad.body.message).toMatch(/rejected the credentials/);

    const good = await admin.call('post', '/api/v1/sources/test', { provider: 'github', baseUrl: mock.baseUrl, scope: 'acme', token: TOKEN });
    expect(good.body).toMatchObject({ ok: true, identity: 'argus-bot' });

    const refused = await admin.call('post', '/api/v1/sources', { name: 'Broken', provider: 'github', baseUrl: mock.baseUrl, scope: 'acme', token: 'wrong-token' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('SOURCE_CONNECTION_FAILED');
  });

  it('creates a source, never returns the token, and syncs repositories across pages', async () => {
    const res = await admin.call('post', '/api/v1/sources', {
      name: 'Mock GitHub',
      provider: 'github',
      baseUrl: mock.baseUrl,
      scope: 'acme',
      token: TOKEN,
      autoActivatePattern: 'acme/app-*',
      defaultTeamId: teamId,
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(res.body.source.tokenHint).toBe(`••••${TOKEN.slice(-4)}`);
    expect(res.body.webhookSecret).toEqual(expect.any(String));
    webhookSecret = res.body.webhookSecret;

    source = await waitFor(
      async () => {
        const list = (await admin.call('get', '/api/v1/sources')).body as SourceDto[];
        const s = list.find((x) => x.id === res.body.source.id);
        return s?.status === 'ok' ? s : null;
      },
      { what: 'source sync' },
    );
    expect(source).toMatchObject({ repoCount: 4, activeRepoCount: 2, lastSyncError: null });
    expect(JSON.stringify(await admin.call('get', '/api/v1/sources'))).not.toContain(TOKEN);

    const repos = (await admin.call('get', `/api/v1/repos?sourceId=${source.id}&pageSize=100`)).body;
    expect(repos.total).toBe(4);
    for (const r of repos.items as RepositoryDto[]) repoByName.set(r.name, r);
    expect(repoByName.get('app-one')).toMatchObject({ active: true, teamId, provider: 'github', schedule: { preset: 'daily' }, visibility: 'private' });
    expect(repoByName.get('lib-three')).toMatchObject({ active: false });
  });

  it('scans newly activated repositories by cloning them, then deletes the workspace', async () => {
    const appOne = repoByName.get('app-one')!;
    const scanned = await waitFor(
      async () => {
        const r = (await admin.call('get', `/api/v1/repos/${appOne.id}`)).body as RepositoryDto;
        return r.lastScanStatus === 'succeeded' || r.lastScanStatus === 'failed' ? r : null;
      },
      { what: 'activation scan', timeoutMs: 90_000 },
    );
    const run = (await admin.call('get', `/api/v1/scans/${scanned.lastScanRunId}`)).body as ScanRunDto;
    expect(run.error).toBeNull();
    expect(scanned.lastScanStatus).toBe('succeeded');
    expect(run).toMatchObject({ status: 'succeeded', trigger: 'activation', commitSha: fixture.sha, branch: 'main' });
    expect(run.stats?.ecosystems).toEqual(['certificates', 'npm', 'nuget']);
    expect(run.stats?.manifests).toEqual(['certs/server.pem', 'package.json', 'src/App.csproj']);
    expect(run.log!.some((l) => l.includes(`Checked out main at ${fixture.sha}`))).toBe(true);

    // The token travelled only as a git HTTP header and never into stored output.
    expect(mock.gitAuthHeaders.length).toBeGreaterThan(0);
    expect(mock.gitAuthHeaders.every((a) => a === EXPECTED_GIT_AUTH)).toBe(true);
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(EXPECTED_GIT_AUTH.split(' ')[1]);

    await waitFor(async () => (await admin.call('get', `/api/v1/repos/${repoByName.get('app-two')!.id}`)).body.lastScanStatus === 'succeeded', { what: 'second scan', timeoutMs: 90_000 });
    expect(existsSync(scanWorkdir) ? readdirSync(scanWorkdir) : []).toEqual([]);

    const history = (await admin.call('get', `/api/v1/repos/${appOne.id}/scans`)).body;
    expect(history.total).toBe(1);
    expect(history.items[0].log).toBeUndefined();
  });

  it('refuses to send credentials to a clone URL on another host', async () => {
    const evil = repoByName.get('evil')!;
    const queued = await admin.call('post', `/api/v1/repos/${evil.id}/scans`);
    expect(queued.status).toBe(202);
    const run = await waitFor(
      async () => {
        const r = (await admin.call('get', `/api/v1/scans/${queued.body.run.id}`)).body as ScanRunDto;
        return r.status === 'failed' ? r : null;
      },
      { what: 'evil scan failure' },
    );
    expect(run.error).toMatch(/Refusing to clone from https:\/\/evil\.invalid/);
    expect(run.attempts).toBe(1);
  });

  it('validates schedules and recomputes the next scan time', async () => {
    const id = repoByName.get('app-one')!.id;
    const tooOften = await admin.call('patch', `/api/v1/repos/${id}`, { schedule: { preset: 'custom', cron: '*/5 * * * *' } });
    expect(tooOften.status).toBe(400);
    expect(tooOften.body.message).toMatch(/15 minutes/);
    const ok = await admin.call('patch', `/api/v1/repos/${id}`, { schedule: { preset: 'custom', cron: '0 3 * * *' }, criticality: 'high', jiraProjectKey: 'PAY' });
    expect(ok.status).toBe(200);
    expect(ok.body.nextScanAt).toMatch(/T03:00:00\.000Z$/);
    expect(ok.body).toMatchObject({ criticality: 'high', jiraProjectKey: 'PAY', schedule: { preset: 'custom', cron: '0 3 * * *' } });

    const manual = await admin.call('patch', `/api/v1/repos/${id}`, { schedule: { preset: 'manual' } });
    expect(manual.body.nextScanAt).toBeNull();
    const off = await admin.call('patch', `/api/v1/repos/${repoByName.get('lib-three')!.id}`, { active: false });
    expect(off.body.nextScanAt).toBeNull();
  });

  it('scopes repositories and scans to the user’s teams', async () => {
    const dev = await admin.call('post', '/api/v1/users', { username: 'dev.scope', displayName: 'Dev', role: 'developer', password: 'Dev-Scope-Pass-1234' });
    const viewer = await admin.call('post', '/api/v1/users', { username: 'viewer.scope', displayName: 'Viewer', role: 'viewer', password: 'Viewer-Scope-Pass-12', teamIds: [teamId] });
    const d = new Client(app);
    await d.login('dev.scope', 'Dev-Scope-Pass-1234');
    await d.call('post', '/api/v1/auth/change-password', { currentPassword: 'Dev-Scope-Pass-1234', newPassword: 'Dev-Scope-Pass-5678' });
    const appOne = repoByName.get('app-one')!;

    expect((await d.call('get', '/api/v1/repos')).body.total).toBe(0);
    expect((await d.call('get', `/api/v1/repos/${appOne.id}`)).status).toBe(404);
    expect((await d.call('post', `/api/v1/repos/${appOne.id}/scans`)).status).toBe(404);
    expect((await d.call('get', '/api/v1/scans')).body.total).toBe(0);
    expect((await d.call('get', '/api/v1/sources')).status).toBe(403);
    expect((await d.call('get', '/api/v1/sources/summary')).status).toBe(200);
    expect((await d.call('patch', `/api/v1/repos/${appOne.id}`, { active: false })).status).toBe(403);

    await admin.call('patch', `/api/v1/users/${dev.body.user.id}`, { teamIds: [teamId] });
    expect((await d.call('get', '/api/v1/repos')).body.total).toBe(4);
    expect((await d.call('get', `/api/v1/repos/${appOne.id}`)).status).toBe(200);
    expect((await d.call('get', '/api/v1/scans')).body.total).toBeGreaterThan(0);

    const v = new Client(app);
    await v.login('viewer.scope', 'Viewer-Scope-Pass-12');
    await v.call('post', '/api/v1/auth/change-password', { currentPassword: 'Viewer-Scope-Pass-12', newPassword: 'Viewer-Scope-Pass-34' });
    expect((await v.call('get', '/api/v1/repos')).body.total).toBe(4);
    expect((await v.call('post', `/api/v1/repos/${appOne.id}/scans`)).status).toBe(403);
    expect(viewer.status).toBe(201);
  });

  it('bulk-updates repositories', async () => {
    const ids = [repoByName.get('lib-three')!.id, repoByName.get('app-two')!.id];
    const res = await admin.call('post', '/api/v1/repos/bulk', { ids, patch: { criticality: 'critical', schedule: { preset: 'weekly' } } });
    expect(res.body).toEqual({ updated: 2 });
    const r = (await admin.call('get', `/api/v1/repos/${ids[0]}`)).body;
    expect(r).toMatchObject({ criticality: 'critical', schedule: { preset: 'weekly' }, nextScanAt: null });
  });

  it('accepts only signed push webhooks and scans pushes to the tracked branch', async () => {
    const appTwo = repoByName.get('app-two')!;
    // supertest serialises the body with JSON.stringify, so signing that string signs the exact bytes sent.
    const send = (body: object, opts: { secret?: string; event?: string } = {}) => {
      const sig = `sha256=${createHmac('sha256', opts.secret ?? webhookSecret).update(JSON.stringify(body)).digest('hex')}`;
      return new Client(app).call('post', `/api/v1/webhooks/${source.id}`, body, { headers: { 'x-github-event': opts.event ?? 'push', 'x-hub-signature-256': sig } });
    };

    expect((await send({ zen: 'hi' }, { event: 'ping' })).body).toMatchObject({ status: 'ok' });
    expect((await send({ ref: 'refs/heads/main', repository: { id: 102 } }, { secret: 'wrong' })).status).toBe(401);
    expect((await send({ ref: 'refs/heads/feature', repository: { id: 102 } })).body).toMatchObject({ status: 'ignored' });
    expect((await send({ ref: 'refs/heads/main', repository: { id: 999 } })).body.status).toBe('ignored');

    const pushed = await send({ ref: 'refs/heads/main', repository: { id: 102 } });
    expect(pushed.status).toBe(202);
    expect(['queued', 'already_queued']).toContain(pushed.body.status);
    await waitFor(
      async () => {
        const runs = (await admin.call('get', `/api/v1/repos/${appTwo.id}/scans`)).body.items as ScanRunDto[];
        return runs.find((r) => r.trigger === 'push' && r.status === 'succeeded');
      },
      { what: 'push-triggered scan', timeoutMs: 90_000 },
    );

    const noSource = await new Client(app).call('post', `/api/v1/webhooks/${crypto.randomUUID()}`, {}, { headers: { 'x-github-event': 'ping' } });
    expect(noSource.status).toBe(404);
  });

  it('audits source and repository administration', async () => {
    const actions = new Set(((await admin.call('get', '/api/v1/audit?pageSize=100')).body.items as { action: string }[]).map((e) => e.action));
    for (const a of ['source.created', 'source.synced', 'repo.updated', 'repo.bulk_updated', 'scan.requested']) expect(actions).toContain(a);
  });

  it('rotates the webhook secret and deletes the source with its repositories', async () => {
    const rotated = await admin.call('post', `/api/v1/sources/${source.id}/webhook-secret`);
    expect(rotated.body.webhookSecret).not.toBe(webhookSecret);
    expect((await admin.call('delete', `/api/v1/sources/${source.id}`)).status).toBe(200);
    expect((await admin.call('get', `/api/v1/repos/${repoByName.get('app-one')!.id}`)).status).toBe(404);
  });
});
