import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { type ApiTokenCreatedDto, type ApiTokenDto } from '@argus/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { AppConfig } from '../../src/config/app-config';
import { BASE_TEST_ENV, Client, dbHarnesses } from './helpers';

const harnesses = dbHarnesses();
const METRICS_TOKEN = 'metrics-token-0123456789';

describe.each(harnesses)('platform e2e: $name', (h) => {
  let app: INestApplication;
  let admin: Client;
  let dev: Client;
  let devId = '';

  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
  const anon = (method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string, token: string, body?: object) => {
    const r = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
    return body ? r.send(body) : r;
  };

  beforeAll(async () => {
    const env = await h.env();
    app = await createApiApp(AppConfig.fromEnv({ ...env, ...BASE_TEST_ENV, ARGUS_ADMIN_PASSWORD: 'Initial-Admin-Pass-1', ARGUS_ROLE: 'api', ARGUS_METRICS_TOKEN: METRICS_TOKEN }));
    await app.init();
    admin = new Client(app);
    await admin.login('admin', 'Initial-Admin-Pass-1');
    await admin.call('post', '/api/v1/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'Second-Root-Pass-9' });
    devId = (await admin.call('post', '/api/v1/users', { username: 'dev.tok', displayName: 'Dev Tok', role: 'developer', password: 'Dev-Tok-Pass-12345', teamIds: [] })).body.user.id;
    dev = new Client(app);
    await dev.login('dev.tok', 'Dev-Tok-Pass-12345');
    await dev.call('post', '/api/v1/auth/change-password', { currentPassword: 'Dev-Tok-Pass-12345', newPassword: 'Dev-Tok-Pass-67890' });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await h.stop();
  });

  describe('API tokens', () => {
    let token = '';
    let tokenId = '';

    it('creates a scoped, expiring token shown once and stored only as a hash', async () => {
      expect((await dev.call('post', '/api/v1/me/tokens', { name: 'CI', scopes: ['findings:read', 'users:manage'], expiresInDays: 30 })).status).toBe(400);
      expect((await dev.call('post', '/api/v1/me/tokens', { name: 'CI', scopes: ['findings:read'], expiresInDays: 3650 })).status).toBe(400);
      const res = await dev.call('post', '/api/v1/me/tokens', { name: 'CI', scopes: ['findings:read', 'repos:read'], expiresInDays: 30 });
      expect(res.status).toBe(201);
      const created = res.body as ApiTokenCreatedDto;
      token = created.token;
      tokenId = created.id;
      expect(token).toMatch(/^argus_pat_[A-Za-z0-9_-]{40,}$/);
      expect(token.startsWith(created.prefix)).toBe(true);
      const days = (new Date(created.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(Math.round(days)).toBe(30);

      const list = (await dev.call('get', '/api/v1/me/tokens')).body as ApiTokenDto[];
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(token);
      const audit = (await admin.call('get', '/api/v1/audit?action=api_token.created')).body.items;
      expect(audit[0]).toMatchObject({ actorName: 'dev.tok', targetId: tokenId });
      expect(JSON.stringify(audit)).not.toContain(token);
    });

    it('authenticates with the token, within its scopes and the owner role, without cookies or CSRF', async () => {
      expect((await anon('get', '/api/v1/findings', token)).status).toBe(200);
      expect((await anon('get', '/api/v1/repos', token)).status).toBe(200);
      // Not in the token's scopes, though the developer role has it.
      const tickets = await anon('get', '/api/v1/tickets', token);
      expect(tickets.status).toBe(403);
      expect(tickets.body.message).toMatch(/lacks the scope: tickets:read/);
      // Endpoints that declare no permission, and session-only endpoints, are closed to tokens.
      expect((await anon('get', '/api/v1/auth/me', token)).status).toBe(403);
      expect((await anon('post', '/api/v1/me/tokens', token, { name: 'x', scopes: ['findings:read'], expiresInDays: 7 })).status).toBe(403);
      expect((await anon('get', '/api/v1/findings', 'argus_pat_not-a-real-token')).status).toBe(401);
      expect((await anon('get', '/api/v1/findings', 'not-even-the-format')).status).toBe(401);
      const used = ((await dev.call('get', '/api/v1/me/tokens')).body as ApiTokenDto[])[0];
      expect(used.lastUsedAt).not.toBeNull();
    });

    it('follows the owner: a role downgrade narrows it, disabling the user stops it', async () => {
      await admin.call('patch', `/api/v1/users/${devId}`, { role: 'viewer' });
      // Viewers can still read findings…
      expect((await anon('get', '/api/v1/findings', token)).status).toBe(200);
      const disabled = await admin.call('patch', `/api/v1/users/${devId}`, { status: 'disabled' });
      expect(disabled.body).toMatchObject({ status: 'disabled' });
      expect((await anon('get', '/api/v1/findings', token)).status).toBe(401);
      await admin.call('patch', `/api/v1/users/${devId}`, { status: 'active', role: 'developer' });
      expect((await anon('get', '/api/v1/findings', token)).status).toBe(200);
    });

    it('can be revoked by its owner or an administrator', async () => {
      const all = (await admin.call('get', '/api/v1/api-tokens')).body as ApiTokenDto[];
      expect(all.find((t) => t.id === tokenId)).toMatchObject({ userName: 'Dev Tok', revokedAt: null });
      expect((await dev.call('get', '/api/v1/api-tokens')).status).toBe(403);
      expect((await admin.call('delete', `/api/v1/api-tokens/${tokenId}`)).status).toBe(200);
      expect((await anon('get', '/api/v1/findings', token)).status).toBe(401);
      expect(((await dev.call('get', '/api/v1/me/tokens')).body as ApiTokenDto[])[0].revokedAt).not.toBeNull();
      const audit = (await admin.call('get', '/api/v1/audit?action=api_token.revoked')).body.items;
      expect(audit[0]).toMatchObject({ actorName: 'admin', targetId: tokenId });
      void bearer;
    });
  });

  describe('metrics and OpenAPI', () => {
    it('serves Prometheus metrics only with the metrics token', async () => {
      expect((await request(app.getHttpServer()).get('/metrics')).status).toBe(401);
      expect((await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer wrong-token-0123456789')).status).toBe(401);
      const res = await request(app.getHttpServer()).get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain;.*version=0\.0\.4/);
      expect(res.text).toMatch(/^# HELP argus_info /m);
      expect(res.text).toContain(`role="api",database="${h.name}"} 1`);
      expect(res.text).toMatch(/^argus_findings_open\{severity="critical"\} \d+$/m);
      expect(res.text).toMatch(/^argus_users 2$/m);
      expect(res.text).toMatch(/^argus_worker_heartbeat_age_seconds -?\d+$/m);
      // Session cookies do not grant access to metrics.
      expect((await admin.call('get', '/metrics')).status).toBe(401);
    });

    it('describes the API from the running code, with permissions and validation schemas', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/openapi.json');
      expect(res.status).toBe(200);
      const doc = res.body as { openapi: string; paths: Record<string, Record<string, Record<string, unknown>>> };
      expect(doc.openapi).toBe('3.1.0');
      const createAdvisory = doc.paths['/api/v1/intel/advisories'].post;
      expect(createAdvisory['x-argus-permissions']).toEqual(['intel:manage']);
      const body = (createAdvisory.requestBody as { content: { 'application/json': { schema: { properties: Record<string, unknown>; required: string[] } } } }).content['application/json'].schema;
      expect(body.required).toEqual(expect.arrayContaining(['ecosystem', 'packageName', 'affectedRange']));
      expect(body.properties.ecosystem).toMatchObject({ enum: ['npm', 'nuget'] });
      const listFindings = doc.paths['/api/v1/findings'].get;
      expect((listFindings.parameters as { name: string; in: string }[]).map((p) => p.name)).toEqual(expect.arrayContaining(['page', 'pageSize', 'repoId']));
      expect(doc.paths['/api/v1/tickets/{id}'].get.parameters).toEqual([expect.objectContaining({ name: 'id', in: 'path' })]);
      expect(doc.paths['/api/v1/me/tokens'].post.security).toEqual([{ session: [] }]);
      expect(doc.paths['/healthz'].get.security).toEqual([]);
      expect(Object.keys(doc.paths).length).toBeGreaterThan(60);
    });
  });
});
