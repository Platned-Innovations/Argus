import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { type ApiTokenCreatedDto, type ApiTokenDto } from '@argus/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { AppConfig } from '../../src/config/app-config';
import { BASE_TEST_ENV, Client, dbHarnesses } from './helpers';

const harnesses = dbHarnesses();

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
    app = await createApiApp(AppConfig.fromEnv({ ...env, ...BASE_TEST_ENV, ARGUS_ADMIN_PASSWORD: 'Initial-Admin-Pass-1', ARGUS_ROLE: 'api' }));
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
});
