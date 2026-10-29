import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { base32Decode, currentStep, hotp } from '../../src/auth/totp';
import { AppConfig } from '../../src/config/app-config';
import { Client, dbHarnesses } from './helpers';

const ADMIN_PASSWORD = 'Initial-Admin-Pass-1';
const NEW_ADMIN_PASSWORD = 'Changed-Root-Pass-2';

const harnesses = dbHarnesses();

const code = (secret: string, offset = 0) => hotp(base32Decode(secret), currentStep() + offset);

describe.each(harnesses)('auth & administration e2e: $name', (h) => {
  let app: INestApplication;
  let admin: Client;

  beforeAll(async () => {
    const env = await h.env();
    const config = AppConfig.fromEnv({
      ...env,
      ARGUS_MASTER_KEY: 'e2e-master-key-0123456789-abcdefghijklmnop',
      ARGUS_ADMIN_PASSWORD: ADMIN_PASSWORD,
      ARGUS_ROLE: 'api',
      ARGUS_WEB_DIR: '/nonexistent',
      LOG_LEVEL: 'silent',
      ARGUS_AUTH_RATE_LIMIT: '1000',
      NODE_ENV: 'test',
    });
    app = await createApiApp(config);
    await app.init();
    admin = new Client(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await h.stop();
  });

  it('reports health and readiness', async () => {
    const c = new Client(app);
    expect((await c.call('get', '/healthz')).body).toEqual({ status: 'ok' });
    const ready = await c.call('get', '/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.database).toEqual({ type: h.name, ok: true });
  });

  it('rejects unauthenticated API calls', async () => {
    expect((await new Client(app).call('get', '/api/v1/users')).status).toBe(401);
  });

  it('answers an unreadable request body with 400, not "Cannot POST" (404)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{');
    expect(res.status).toBe(400);
    expect(res.body.message).not.toMatch(/Cannot POST/);
  });

  it('seeds the admin, who must change the password before doing anything else', async () => {
    const bad = await new Client(app).login('admin', 'wrong-password');
    expect(bad.status).toBe(401);

    const res = await admin.login('admin', ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.user.restrictions.passwordChangeRequired).toBe(true);
    expect(admin.cookies.has('argus_at') && admin.cookies.has('argus_rt') && admin.cookies.has('argus_csrf')).toBe(true);
    expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';')).toMatch(/argus_at=[^;]+;.*HttpOnly/i);

    const blocked = await admin.call('get', '/api/v1/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = await admin.call('post', '/api/v1/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('PASSWORD_POLICY');

    const ok = await admin.call('post', '/api/v1/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: NEW_ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.restrictions.passwordChangeRequired).toBe(false);

    const users = await admin.call('get', '/api/v1/users');
    expect(users.status).toBe(200);
    expect(users.body.total).toBe(1);
    expect(users.body.items[0]).not.toHaveProperty('passwordHash');
  });

  it('enforces CSRF on cookie-authenticated writes', async () => {
    const res = await admin.call('post', '/api/v1/teams', { name: 'No CSRF' }, { csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF');
  });

  let devId = '';
  let devPassword = '';

  it('manages teams and users, returning temporary passwords once', async () => {
    const team = await admin.call('post', '/api/v1/teams', { name: 'Payments', description: 'Payments platform' });
    expect(team.status).toBe(201);
    expect((await admin.call('post', '/api/v1/teams', { name: 'payments' })).status).toBe(409);

    const created = await admin.call('post', '/api/v1/users', { username: 'dev.one', displayName: 'Dev One', email: 'dev@example.com', role: 'developer', teamIds: [team.body.id] });
    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toEqual(expect.any(String));
    expect(created.body.user.mustChangePassword).toBe(true);
    devId = created.body.user.id;
    devPassword = created.body.temporaryPassword;

    expect((await admin.call('post', '/api/v1/users', { username: 'DEV.ONE', displayName: 'x', role: 'viewer' })).status).toBe(409);
    expect((await admin.call('post', '/api/v1/users', { username: 'bad', displayName: 'x', role: 'viewer', teamIds: [crypto.randomUUID()] })).status).toBe(400);

    const teams = await admin.call('get', '/api/v1/teams');
    expect(teams.body.find((t: { name: string }) => t.name === 'Payments').memberCount).toBe(1);
    expect((await admin.call('get', `/api/v1/users?teamId=${team.body.id}`)).body.total).toBe(1);
  });

  it('enforces role permissions', async () => {
    const dev = new Client(app);
    await dev.login('dev.one', devPassword);
    const changed = await dev.call('post', '/api/v1/auth/change-password', { currentPassword: devPassword, newPassword: 'Dev-Strong-Pass-77' });
    expect(changed.status).toBe(200);
    devPassword = 'Dev-Strong-Pass-77';
    expect((await dev.call('get', '/api/v1/users')).status).toBe(403);
    expect((await dev.call('get', '/api/v1/audit')).status).toBe(403);
    expect((await dev.call('get', '/api/v1/teams')).status).toBe(200);
    expect((await dev.call('get', '/api/v1/auth/me')).body.permissions).toContain('tickets:write');
  });

  it('locks accounts after repeated failures, and admins can unlock them', async () => {
    const c = new Client(app);
    for (let i = 0; i < 5; i++) expect((await c.login('dev.one', 'nope-nope-nope')).status).toBe(401);
    const locked = await c.login('dev.one', devPassword);
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect((await admin.call('get', `/api/v1/users/${devId}`)).body.lockedUntil).not.toBeNull();

    expect((await admin.call('post', `/api/v1/users/${devId}/unlock`)).status).toBe(200);
    expect((await c.login('dev.one', devPassword)).status).toBe(200);
  });

  it('rotates refresh tokens and rejects the rotated one', async () => {
    const c = new Client(app);
    await c.login('dev.one', devPassword);
    const oldRefresh = c.cookies.get('argus_rt')!;
    expect((await c.call('post', '/api/v1/auth/refresh')).status).toBe(200);
    expect(c.cookies.get('argus_rt')).not.toBe(oldRefresh);

    const replay = new Client(app);
    replay.cookies.set('argus_rt', oldRefresh);
    replay.cookies.set('argus_csrf', c.cookies.get('argus_csrf')!);
    expect((await replay.call('post', '/api/v1/auth/refresh')).status).toBe(401);
    expect((await c.call('post', '/api/v1/auth/refresh')).status).toBe(200);
  });

  it('enrolls in MFA, blocks code replay, and accepts single-use recovery codes', async () => {
    const c = new Client(app);
    await c.login('dev.one', devPassword);
    const setup = await c.call('post', '/api/v1/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret: string = setup.body.secret;

    expect((await c.call('post', '/api/v1/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    const enrollCode = code(secret);
    const enabled = await c.call('post', '/api/v1/auth/mfa/enable', { code: enrollCode });
    expect(enabled.status).toBe(200);
    expect(enabled.body.recoveryCodes).toHaveLength(10);

    const fresh = new Client(app);
    const step1 = await fresh.login('dev.one', devPassword);
    expect(step1.body.status).toBe('mfa_required');
    expect(fresh.cookies.has('argus_at')).toBe(false);

    // The code used during enrollment cannot be replayed.
    expect((await fresh.call('post', '/api/v1/auth/mfa/verify', { mfaToken: step1.body.mfaToken, code: enrollCode })).status).toBe(401);

    const recovery = enabled.body.recoveryCodes[0];
    const ok = await fresh.call('post', '/api/v1/auth/mfa/verify', { mfaToken: step1.body.mfaToken, code: recovery.toUpperCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.user.mfaEnabled).toBe(true);

    const again = await new Client(app).login('dev.one', devPassword);
    expect((await new Client(app).call('post', '/api/v1/auth/mfa/verify', { mfaToken: again.body.mfaToken, code: recovery })).status).toBe(401);
    await admin.call('post', `/api/v1/users/${devId}/unlock`);
  });

  it('creates accounts from invite links with a preset role and teams, until used up, expired or revoked', async () => {
    const team = (await admin.call('post', '/api/v1/teams', { name: 'Invited' })).body;
    const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
    expect((await admin.call('post', '/api/v1/invites', { role: 'developer', expiresAt: inDays(-1) })).status).toBe(400);
    expect((await admin.call('post', '/api/v1/invites', { role: 'developer', expiresAt: inDays(400) })).status).toBe(400);
    expect((await admin.call('post', '/api/v1/invites', { role: 'developer', email: 'x@example.com', maxUses: 2, expiresAt: inDays(7) })).status).toBe(400);

    const created = await admin.call('post', '/api/v1/invites', { role: 'developer', teamIds: [team.id], expiresAt: inDays(7), note: 'New starter' });
    expect(created.status).toBe(201);
    const { token, invite } = created.body;
    expect(invite).toMatchObject({ role: 'developer', teamIds: [team.id], uses: 0, maxUses: 1, status: 'active', note: 'New starter' });
    expect(JSON.stringify((await admin.call('get', '/api/v1/invites')).body)).not.toContain(token);

    const guest = new Client(app);
    expect((await guest.call('post', '/api/v1/invites/lookup', { token: 'not-a-real-invite-token' })).status).toBe(404);
    expect((await guest.call('post', '/api/v1/invites/lookup', { token })).body).toMatchObject({ role: 'developer', teams: ['Invited'], email: null });
    const signUp = { token, username: 'invited.dev', displayName: 'Invited Dev', email: 'invited@example.com', password: 'Invited-Dev-Pass-2026' };
    expect((await guest.call('post', '/api/v1/invites/accept', { ...signUp, password: 'short' })).status).toBe(400);
    expect((await guest.call('post', '/api/v1/invites/accept', { ...signUp, username: 'admin' })).status).toBe(409);
    expect((await guest.call('post', '/api/v1/invites/accept', signUp)).body).toEqual({ username: 'invited.dev' });
    expect((await guest.call('post', '/api/v1/invites/accept', { ...signUp, username: 'invited.two', email: null })).status).toBe(404);

    expect((await guest.login('invited.dev', signUp.password)).status).toBe(200);
    const me = (await guest.call('get', '/api/v1/auth/me')).body;
    expect(me).toMatchObject({ role: 'developer', teamIds: [team.id], email: 'invited@example.com', restrictions: { passwordChangeRequired: false } });
    expect((await guest.call('post', '/api/v1/invites', { role: 'admin', expiresAt: inDays(1) })).status).toBe(403);
    expect((await admin.call('get', '/api/v1/invites')).body.find((i: { id: string }) => i.id === invite.id)).toMatchObject({ status: 'used', uses: 1 });

    const second = (await admin.call('post', '/api/v1/invites', { role: 'viewer', email: 'only@example.com', expiresAt: inDays(1) })).body;
    expect((await guest.call('post', '/api/v1/invites/lookup', { token: second.token })).body).toMatchObject({ role: 'viewer', email: 'only@example.com' });
    expect((await admin.call('delete', `/api/v1/invites/${second.invite.id}`)).status).toBe(200);
    expect((await guest.call('post', '/api/v1/invites/lookup', { token: second.token })).status).toBe(404);

    const actions = new Set(((await admin.call('get', '/api/v1/audit?pageSize=100')).body.items as { action: string }[]).map((e) => e.action));
    for (const a of ['invite.created', 'invite.revoked']) expect(actions).toContain(a);
  });

  it('applies MFA-required policy to users without MFA', async () => {
    const current = (await admin.call('get', '/api/v1/settings/security')).body;
    expect((await admin.call('put', '/api/v1/settings/security', { ...current, mfaRequired: true })).status).toBe(200);

    const blocked = await admin.call('get', '/api/v1/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await admin.call('get', '/api/v1/auth/me')).body.restrictions.mfaEnrollmentRequired).toBe(true);

    const setup = await admin.call('post', '/api/v1/auth/mfa/setup');
    expect((await admin.call('post', '/api/v1/auth/mfa/enable', { code: code(setup.body.secret) })).status).toBe(200);
    expect((await admin.call('get', '/api/v1/users')).status).toBe(200);
    expect((await admin.call('post', '/api/v1/auth/mfa/disable', { password: NEW_ADMIN_PASSWORD, code: code(setup.body.secret, 1) })).status).toBe(403);

    await admin.call('put', '/api/v1/settings/security', { ...current, mfaRequired: false });
  });

  it('protects against self-lockout and removing the last admin', async () => {
    const me = (await admin.call('get', '/api/v1/auth/me')).body;
    expect((await admin.call('patch', `/api/v1/users/${me.id}`, { status: 'disabled' })).status).toBe(403);
    expect((await admin.call('patch', `/api/v1/users/${me.id}`, { role: 'viewer' })).status).toBe(403);
  });

  it('cuts off disabled users immediately', async () => {
    const c = new Client(app);
    const viewer = await admin.call('post', '/api/v1/users', { username: 'viewer.one', displayName: 'Viewer', role: 'viewer', password: 'Viewer-Initial-Pass-1' });
    await c.login('viewer.one', 'Viewer-Initial-Pass-1');
    expect((await c.call('get', '/api/v1/auth/me')).status).toBe(200);
    await admin.call('patch', `/api/v1/users/${viewer.body.user.id}`, { status: 'disabled' });
    expect((await c.call('get', '/api/v1/auth/me')).status).toBe(401);
    expect((await c.call('post', '/api/v1/auth/refresh')).status).toBe(401);
    expect((await new Client(app).login('viewer.one', 'Viewer-Initial-Pass-1')).status).toBe(401);
  });

  it('records an audit trail and exports it safely', async () => {
    const page = await admin.call('get', '/api/v1/audit?pageSize=100');
    const actions = new Set(page.body.items.map((e: { action: string }) => e.action));
    for (const a of ['system.admin_seeded', 'auth.login', 'auth.password_changed', 'user.created', 'team.created', 'auth.account_locked', 'auth.mfa_enabled', 'settings.security_updated']) {
      expect(actions).toContain(a);
    }
    const failures = await admin.call('get', '/api/v1/audit?action=auth.login&outcome=failure');
    expect(failures.body.total).toBeGreaterThan(0);

    const csv = await admin.call('get', '/api/v1/audit/export');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('at,actor,action,outcome,target_type,target_id,ip,details');
  });

  it('logs out and revokes the session', async () => {
    const rt = admin.cookies.get('argus_rt')!;
    expect((await admin.call('post', '/api/v1/auth/logout')).status).toBe(200);
    expect(admin.cookies.has('argus_at')).toBe(false);
    const res = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', `argus_rt=${rt}; argus_csrf=x`).set('x-csrf-token', 'x');
    expect(res.status).toBe(401);
  });
});
