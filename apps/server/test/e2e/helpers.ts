import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

/** Minimal cookie-aware client that echoes the CSRF cookie like the SPA does. */
export class Client {
  cookies = new Map<string, string>();

  constructor(private readonly app: INestApplication) {}

  async call(method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: object, opts: { csrf?: boolean; headers?: Record<string, string> } = {}) {
    let r = request(this.app.getHttpServer())[method](path).set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const csrf = this.cookies.get('argus_csrf');
    if (csrf && opts.csrf !== false) r = r.set('x-csrf-token', csrf);
    for (const [k, v] of Object.entries(opts.headers ?? {})) r = r.set(k, v);
    const res = await (body ? r.send(body) : r);
    for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx);
      const value = decodeURIComponent(pair.slice(idx + 1));
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  login(username: string, password: string) {
    return this.call('post', '/api/v1/auth/login', { username, password });
  }
}

export interface DbHarness {
  name: 'postgres' | 'mongodb';
  env(): Promise<Record<string, string>>;
  stop(): Promise<void>;
}

/** One harness per supported database, each backed by a throwaway container. */
export function dbHarnesses(): DbHarness[] {
  let pg: StartedPostgreSqlContainer | undefined;
  let mongo: StartedMongoDBContainer | undefined;
  return [
    {
      name: 'postgres',
      async env() {
        pg = await new PostgreSqlContainer('postgres:17-alpine').start();
        return { ARGUS_DB_TYPE: 'postgres', ARGUS_DB_URL: pg.getConnectionUri() };
      },
      stop: async () => void (await pg?.stop()),
    },
    {
      name: 'mongodb',
      async env() {
        mongo = await new MongoDBContainer('mongo:8').start();
        return { ARGUS_DB_TYPE: 'mongodb', ARGUS_DB_URL: `${mongo.getConnectionString()}?directConnection=true`, ARGUS_DB_NAME: 'argus_e2e' };
      },
      stop: async () => void (await mongo?.stop()),
    },
  ];
}

export const BASE_TEST_ENV = {
  ARGUS_MASTER_KEY: 'e2e-master-key-0123456789-abcdefghijklmnop',
  ARGUS_WEB_DIR: '/nonexistent',
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  ARGUS_AUTH_RATE_LIMIT: '1000',
};

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 250));
  }
  throw new Error(`Timed out waiting for ${opts.what ?? 'condition'}${last ? `: ${String(last)}` : ''}`);
}
