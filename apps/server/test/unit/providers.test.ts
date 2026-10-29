import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCloneUrlAllowed, createProviderClient, parseWebhook, ProviderError, verifyWebhookSignature } from '../../src/sources/providers';
import { githubAppJwt, isGitHubApp } from '../../src/sources/providers/github';

type Route = (url: URL, init: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> };

function mockFetch(route: Route) {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      calls.push({ url: url.toString(), auth: headers.get('authorization') });
      const r = route(url, init);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const ghRepo = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  full_name: `acme/r${id}`,
  name: `r${id}`,
  owner: { login: 'acme' },
  html_url: `https://github.com/acme/r${id}`,
  clone_url: `https://github.com/acme/r${id}.git`,
  default_branch: 'main',
  private: true,
  language: 'C#',
  description: null,
  archived: false,
  pushed_at: '2026-10-01T00:00:00Z',
  ...extra,
});

describe('GitHub client', () => {
  it('lists organisation repositories across pages with a bearer token', async () => {
    const calls = mockFetch((url) => {
      if (url.pathname === '/orgs/acme/repos' && url.searchParams.get('per_page') === '1') return { body: [ghRepo(1)] };
      if (url.pathname === '/orgs/acme/repos' && !url.searchParams.get('page'))
        return { body: [ghRepo(1), ghRepo(2, { visibility: 'internal' })], headers: { link: '<https://api.github.com/orgs/acme/repos?per_page=100&page=2>; rel="next", <x>; rel="last"' } };
      if (url.searchParams.get('page') === '2') return { body: [ghRepo(3, { private: false, archived: true })] };
      return { status: 404, body: {} };
    });
    const repos = await createProviderClient({ provider: 'github', baseUrl: null, scope: 'acme', username: null, token: 'ghp_secret' }).listRepositories();
    expect(repos.map((r) => [r.externalId, r.visibility, r.archived])).toEqual([
      ['1', 'private', false],
      ['2', 'internal', false],
      ['3', 'public', true],
    ]);
    expect(repos[0].lastPushedAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(calls.every((c) => c.auth === 'Bearer ghp_secret')).toBe(true);
  });

  it('falls back to the user listing when the scope is a user, not an organisation', async () => {
    mockFetch((url) => {
      if (url.pathname.startsWith('/orgs/')) return { status: 404, body: {} };
      if (url.pathname === '/user/repos') return { body: [ghRepo(1), ghRepo(2, { owner: { login: 'someone-else' }, full_name: 'someone-else/r2' })] };
      return { status: 404, body: {} };
    });
    const repos = await createProviderClient({ provider: 'github', baseUrl: null, scope: 'ACME', username: null, token: 't' }).listRepositories();
    expect(repos.map((r) => r.fullName)).toEqual(['acme/r1']);
  });

  it('uses /api/v3 on GitHub Enterprise Server and refuses pagination links to other hosts', async () => {
    const calls = mockFetch((url) => {
      if (url.pathname === '/api/v3/repos-check') return { body: [] };
      if (url.pathname === '/api/v3/user/repos') return { body: [ghRepo(1)], headers: { link: '<https://evil.example/steal?page=2>; rel="next"' } };
      return { status: 404, body: {} };
    });
    const client = createProviderClient({ provider: 'github', baseUrl: 'https://ghe.example.com/', scope: null, username: null, token: 't' });
    await expect(client.listRepositories()).rejects.toThrow(/Refusing to call https:\/\/evil\.example/);
    expect(calls.every((c) => c.url.startsWith('https://ghe.example.com/api/v3/'))).toBe(true);
    expect(client.allowedCloneHosts()).toEqual(['ghe.example.com']);
  });

  it('reports actionable errors', async () => {
    mockFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const err = await createProviderClient({ provider: 'github', baseUrl: null, scope: null, username: null, token: 't' })
      .check()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/rejected the credentials/);
    expect((err as ProviderError).permanent).toBe(true);

    mockFetch(() => ({ status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } }));
    const limited = (await createProviderClient({ provider: 'github', baseUrl: null, scope: null, username: null, token: 't' })
      .check()
      .catch((e: unknown) => e)) as ProviderError;
    expect(limited.message).toMatch(/rate limit/);
    expect(limited.permanent).toBe(false);
  });

  it('rejects plain-http and credential-bearing server URLs', () => {
    expect(() => createProviderClient({ provider: 'github', baseUrl: 'http://ghe.example.com', scope: null, username: null, token: 't' })).toThrow(/https/);
    expect(() => createProviderClient({ provider: 'github', baseUrl: 'https://u:p@ghe.example.com', scope: null, username: null, token: 't' })).toThrow(/credentials/);
    expect(() => createProviderClient({ provider: 'github', baseUrl: 'http://127.0.0.1:9999', scope: null, username: null, token: 't' })).not.toThrow();
  });

  it('authenticates git with an x-access-token basic header', async () => {
    const header = await createProviderClient({ provider: 'github', baseUrl: null, scope: null, username: null, token: 'tok' }).gitAuthHeader();
    expect(header).toBe(`Authorization: Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
  });

  it('signs GitHub App JWTs with the private key, valid for under ten minutes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Date.UTC(2026, 9, 1, 12);
    const jwt = githubAppJwt('123', privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), now);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iss: '123', iat: now / 1000 - 60, exp: now / 1000 + 480 });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(() => githubAppJwt('abc', 'x')).toThrow(/App ID must be a number/);
    expect(() => githubAppJwt('1', 'not a key')).toThrow(/private key is not valid/);
    expect(isGitHubApp({ provider: 'github', username: '123' })).toBe(true);
    expect(isGitHubApp({ provider: 'bitbucket_cloud', username: 'me@example.com' })).toBe(false);
  });
});

describe('Bitbucket Cloud client', () => {
  const repo = (n: number) => ({
    uuid: `{uuid-${n}}`,
    full_name: `ws/r${n}`,
    name: `r${n}`,
    is_private: n !== 2,
    language: '',
    description: '',
    updated_on: '2026-09-01T00:00:00Z',
    mainbranch: { name: 'master' },
    links: { html: { href: `https://bitbucket.org/ws/r${n}` }, clone: [{ name: 'https', href: `https://someone@bitbucket.org/ws/r${n}.git` }, { name: 'ssh', href: 'git@x' }] },
  });

  it('follows next links and strips user info from clone URLs; uses basic auth with a username', async () => {
    const calls = mockFetch((url) =>
      url.searchParams.get('page') === '2' ? { body: { values: [repo(2)] } } : { body: { values: [repo(1)], next: 'https://api.bitbucket.org/2.0/repositories/ws?pagelen=100&page=2' } },
    );
    const client = createProviderClient({ provider: 'bitbucket_cloud', baseUrl: null, scope: 'ws', username: 'me@example.com', token: 'tok' });
    const repos = await client.listRepositories();
    expect(repos.map((r) => [r.externalId, r.cloneUrl, r.visibility, r.language, r.defaultBranch])).toEqual([
      ['{uuid-1}', 'https://bitbucket.org/ws/r1.git', 'private', null, 'master'],
      ['{uuid-2}', 'https://bitbucket.org/ws/r2.git', 'public', null, 'master'],
    ]);
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('me@example.com:tok').toString('base64')}`);
    expect(client.allowedCloneHosts()).toEqual(['bitbucket.org']);
  });

  it('uses bearer auth for access tokens and x-token-auth for git', async () => {
    const calls = mockFetch(() => ({ body: { values: [], size: 42 } }));
    const client = createProviderClient({ provider: 'bitbucket_cloud', baseUrl: null, scope: 'ws', username: null, token: 'atok' });
    expect(await client.check()).toEqual({ identity: 'access token', visibleRepos: 42 });
    expect(calls[0].auth).toBe('Bearer atok');
    expect(await client.gitAuthHeader()).toBe(`Authorization: Basic ${Buffer.from('x-token-auth:atok').toString('base64')}`);
  });

  it('requires a workspace', () => {
    expect(() => createProviderClient({ provider: 'bitbucket_cloud', baseUrl: null, scope: null, username: null, token: 't' })).toThrow(/workspace/);
  });
});

describe('Bitbucket Data Center client', () => {
  it('pages with start/limit within a project and maps repositories', async () => {
    const calls = mockFetch((url) => {
      const start = Number(url.searchParams.get('start'));
      const mk = (id: number) => ({
        id,
        slug: `r${id}`,
        name: `R${id}`,
        project: { key: 'PAY' },
        public: false,
        links: { self: [{ href: `https://bb.corp/projects/PAY/repos/r${id}` }], clone: [{ name: 'http', href: `https://admin@bb.corp/scm/pay/r${id}.git` }] },
      });
      return start === 0 ? { body: { values: [mk(1)], isLastPage: false, nextPageStart: 1 } } : { body: { values: [mk(2)], isLastPage: true } };
    });
    const client = createProviderClient({ provider: 'bitbucket_server', baseUrl: 'https://bb.corp/', scope: 'PAY', username: null, token: 'http-token' });
    const repos = await client.listRepositories();
    expect(repos.map((r) => [r.externalId, r.fullName, r.cloneUrl, r.defaultBranch])).toEqual([
      ['1', 'PAY/r1', 'https://bb.corp/scm/pay/r1.git', null],
      ['2', 'PAY/r2', 'https://bb.corp/scm/pay/r2.git', null],
    ]);
    expect(calls[0].url).toBe('https://bb.corp/rest/api/1.0/projects/PAY/repos?limit=100&start=0');
    expect(calls[0].auth).toBe('Bearer http-token');
    expect(await client.gitAuthHeader()).toBe('Authorization: Bearer http-token');
  });

  it('requires a server URL', () => {
    expect(() => createProviderClient({ provider: 'bitbucket_server', baseUrl: null, scope: null, username: null, token: 't' })).toThrow(/server URL/);
  });
});

describe('clone URL safety', () => {
  const gh = createProviderClient({ provider: 'github', baseUrl: null, scope: null, username: null, token: 't' });

  it('allows the provider host over https and strips credentials', () => {
    expect(assertCloneUrlAllowed(gh, 'https://x:y@github.com/acme/r.git').toString()).toBe('https://github.com/acme/r.git');
  });

  it('refuses other hosts, plain http and other schemes before credentials are attached', () => {
    expect(() => assertCloneUrlAllowed(gh, 'https://evil.example/acme/r.git')).toThrow(/Refusing to clone/);
    expect(() => assertCloneUrlAllowed(gh, 'http://github.com/acme/r.git')).toThrow(/Refusing to clone/);
    expect(() => assertCloneUrlAllowed(gh, 'file:///etc/passwd')).toThrow(/Refusing to clone/);
    expect(() => assertCloneUrlAllowed(gh, 'not a url')).toThrow(/not valid/);
  });
});

describe('webhooks', () => {
  const secret = 'shh';
  const body = Buffer.from('{"a":1}');
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('verifies HMAC-SHA256 signatures', () => {
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
    expect(verifyWebhookSignature('other', body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, Buffer.from('{"a":2}'), sig)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha1=abc')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=zz')).toBe(false);
  });

  it('parses GitHub pushes and pings', () => {
    expect(parseWebhook('github', { 'x-github-event': 'ping' }, {})).toEqual({ kind: 'ping' });
    expect(parseWebhook('github', { 'x-github-event': 'push' }, { ref: 'refs/heads/main', repository: { id: 7 } })).toEqual({ kind: 'push', externalId: '7', branches: ['main'] });
    expect(parseWebhook('github', { 'x-github-event': 'push' }, { ref: 'refs/tags/v1', repository: { id: 7 } }).kind).toBe('ignored');
    expect(parseWebhook('github', { 'x-github-event': 'push' }, { ref: 'refs/heads/x', deleted: true, repository: { id: 7 } }).kind).toBe('ignored');
    expect(parseWebhook('github', { 'x-github-event': 'issues' }, {}).kind).toBe('ignored');
  });

  it('parses Bitbucket Cloud and Data Center pushes', () => {
    expect(
      parseWebhook('bitbucket_cloud', { 'x-event-key': 'repo:push' }, { repository: { uuid: '{u}' }, push: { changes: [{ new: { type: 'branch', name: 'main' } }, { new: { type: 'tag', name: 'v1' } }, { new: null }] } }),
    ).toEqual({ kind: 'push', externalId: '{u}', branches: ['main'] });
    expect(parseWebhook('bitbucket_server', { 'x-event-key': 'diagnostics:ping' }, {})).toEqual({ kind: 'ping' });
    expect(
      parseWebhook(
        'bitbucket_server',
        { 'x-event-key': 'repo:refs_changed' },
        { repository: { id: 3 }, changes: [{ ref: { type: 'BRANCH', displayId: 'develop' }, type: 'UPDATE' }, { ref: { type: 'BRANCH', displayId: 'old' }, type: 'DELETE' }] },
      ),
    ).toEqual({ kind: 'push', externalId: '3', branches: ['develop'] });
  });
});
