import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { dirname, join, normalize } from 'node:path';

export interface FixtureRepo {
  bare: string;
  work: string;
  sha: string;
  /** Replaces files (null deletes), commits and publishes the new commit. Returns the new SHA. */
  commit(files: Record<string, string | Buffer | null>, message: string): string;
}

const git = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=Argus Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();

function writeFiles(work: string, files: Record<string, string | Buffer | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(work, path);
    if (content === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
}

/** A git repository served over git's "dumb" HTTP protocol (static files from a bare repository). */
export function createGitRepo(root: string, files: Record<string, string | Buffer>): FixtureRepo {
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  writeFiles(work, files);
  git(['init', '-q', '-b', 'main'], work);
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'initial'], work);
  const bare = join(root, 'bare.git');
  git(['clone', '-q', '--bare', work, bare], root);
  git(['update-server-info'], bare);
  const repo: FixtureRepo = {
    bare,
    work,
    sha: git(['rev-parse', 'HEAD'], work),
    commit(changes, message) {
      writeFiles(work, changes);
      git(['add', '-A'], work);
      git(['commit', '-q', '-m', message], work);
      git(['push', '-q', bare, 'main'], work);
      git(['update-server-info'], bare);
      repo.sha = git(['rev-parse', 'HEAD'], work);
      return repo.sha;
    },
  };
  return repo;
}

export interface MockRepo {
  id: number;
  name: string;
  /** Overrides the clone URL (e.g. to simulate a tampered host). */
  cloneUrl?: string;
}

export type ExtraRoute = (req: IncomingMessage, url: URL, body: string, res: ServerResponse) => boolean;

export interface MockGitHub {
  server: Server;
  baseUrl: string;
  gitAuthHeaders: string[];
}

/** Just enough of the GitHub Enterprise REST API, plus static git files for every acme/*.git clone URL. */
export async function startMockGitHub(opts: { bare: string; token: string; repos: MockRepo[]; extra?: ExtraRoute }): Promise<MockGitHub> {
  const gitAuthHeaders: string[] = [];
  const expectedGitAuth = `Basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}`;
  const state = { baseUrl: '' };
  const repo = (r: MockRepo) => ({
    id: r.id,
    full_name: `acme/${r.name}`,
    name: r.name,
    owner: { login: 'acme' },
    html_url: `${state.baseUrl}/acme/${r.name}`,
    clone_url: r.cloneUrl ?? `${state.baseUrl}/acme/${r.name}.git`,
    default_branch: 'main',
    private: true,
    language: 'TypeScript',
    description: `${r.name} service`,
    archived: false,
    pushed_at: '2026-10-01T00:00:00Z',
  });

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', state.baseUrl);
      const body = Buffer.concat(chunks).toString('utf8');
      if (opts.extra?.(req, url, body, res)) return;
      const json = (data: unknown, headers: Record<string, string> = {}) => res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(data));

      if (url.pathname.startsWith('/api/v3/')) {
        if (req.headers.authorization !== `Bearer ${opts.token}`) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Bad credentials"}');
        if (url.pathname === '/api/v3/user') return json({ login: 'argus-bot' });
        // GitHub App installations list their repositories here (authorized with an installation token).
        if (url.pathname === '/api/v3/installation/repositories') return json({ total_count: opts.repos.length, repositories: opts.repos.map(repo) });
        if (url.pathname === '/api/v3/orgs/acme/repos') {
          const half = Math.ceil(opts.repos.length / 2);
          if (url.searchParams.get('per_page') === '1') return json(opts.repos.slice(0, 1).map(repo));
          if (url.searchParams.get('page') === '2') return json(opts.repos.slice(half).map(repo));
          return json(opts.repos.slice(0, half).map(repo), half < opts.repos.length ? { link: `<${state.baseUrl}/api/v3/orgs/acme/repos?per_page=100&page=2>; rel="next"` } : {});
        }
        return void res.writeHead(404).end();
      }

      const m = /^\/acme\/[\w-]+\.git\/(.+)$/.exec(url.pathname);
      if (m) {
        gitAuthHeaders.push(req.headers.authorization ?? '');
        if (req.headers.authorization !== expectedGitAuth) return void res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end();
        const file = normalize(join(opts.bare, m[1]));
        if (!file.startsWith(normalize(opts.bare)) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
        return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(file));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, baseUrl: state.baseUrl, gitAuthHeaders };
}
