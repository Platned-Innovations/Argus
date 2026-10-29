import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createGitRepo, startMockGitHub } from '../apps/server/test/e2e/mock-github';
import { PORT } from './playwright.config';

const root = resolve(import.meta.dirname, '..');
export const ADMIN_PASSWORD = 'Initial-Admin-Pass-1';
export const GITHUB_TOKEN = 'ghp_browserTestToken0123456789';

/** Starts PostgreSQL, a mock GitHub serving one fixture repository, and the built Argus server. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const main = join(root, 'apps/server/dist/main.js');
  const web = join(root, 'apps/web/dist/index.html');
  if (!existsSync(main) || !existsSync(web)) throw new Error('Build Argus first: run "npm run build" at the repository root.');

  const tmp = mkdtempSync(join(tmpdir(), 'argus-browser-'));
  // A repository with committed secrets (assembled here so this file holds no token-like literal).
  const fixture = createGitRepo(tmp, {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { lodash: '4.17.20' } }),
    'src/config.js': `module.exports = { github: "${['ghp_', 'Br0wser'.repeat(5), 'x'].join('')}", aws: "${['AKIA', 'BROWSERTEST0001'].join('')}X" };\n`,
  });
  const github = await startMockGitHub({ bare: fixture.bare, token: GITHUB_TOKEN, repos: [{ id: 301, name: 'shop' }, { id: 302, name: 'billing' }] });
  const pg = await new PostgreSqlContainer('postgres:17-alpine').start();

  const server: ChildProcess = spawn(process.execPath, [main], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_ENV: 'test',
      PORT: String(PORT),
      ARGUS_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      ARGUS_DB_TYPE: 'postgres',
      ARGUS_DB_URL: pg.getConnectionUri(),
      ARGUS_MASTER_KEY: 'browser-master-key-0123456789-abcdefghijk',
      ARGUS_ADMIN_PASSWORD: ADMIN_PASSWORD,
      ARGUS_ROLE: 'all',
      ARGUS_WEB_DIR: join(root, 'apps/web/dist'),
      ARGUS_SCAN_WORKDIR: join(tmp, 'scans'),
      ARGUS_OFFLINE: 'true',
      ARGUS_GITLEAKS_PATH: 'argus-browser-no-gitleaks',
      ARGUS_SCHEDULER_INTERVAL_SECONDS: '1',
      ARGUS_AUTH_RATE_LIMIT: '1000',
      LOG_LEVEL: 'warn',
    },
  });
  let output = '';
  server.stdout?.on('data', (c: Buffer) => (output = (output + c.toString()).slice(-20_000)));
  server.stderr?.on('data', (c: Buffer) => (output = (output + c.toString()).slice(-20_000)));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`Argus exited during start-up:\n${output}`);
    const ok = await fetch(`http://127.0.0.1:${PORT}/readyz`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`Argus did not become ready:\n${output}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  process.env.ARGUS_E2E_GITHUB_URL = github.baseUrl;

  return async () => {
    server.kill();
    github.server.close();
    await pg.stop();
    rmSync(tmp, { recursive: true, force: true });
  };
}
