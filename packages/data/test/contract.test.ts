import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataStore, type DataStore, DuplicateKeyError, type NewUser } from '../src';
import { findingsContract } from './findings.contract';
import { scanningContract } from './scanning.contract';

/**
 * One behavioural contract, executed against every DataStore adapter.
 * Any difference between PostgreSQL and MongoDB behaviour is a bug.
 */
interface Harness {
  name: string;
  start(): Promise<DataStore>;
  stop(): Promise<void>;
}

let pg: StartedPostgreSqlContainer | undefined;
let mongo: StartedMongoDBContainer | undefined;
let dbCounter = 0;

const harnesses: Harness[] = [
  {
    name: 'postgres',
    async start() {
      pg = await new PostgreSqlContainer('postgres:17-alpine').start();
      return createDataStore({ kind: 'postgres', url: pg.getConnectionUri() });
    },
    async stop() {
      await pg?.stop();
    },
  },
  {
    name: 'mongodb',
    async start() {
      mongo = await new MongoDBContainer('mongo:8').start();
      return createDataStore({ kind: 'mongodb', url: `${mongo.getConnectionString()}?directConnection=true`, dbName: `argus_test_${++dbCounter}` });
    },
    async stop() {
      await mongo?.stop();
    },
  },
];

const newUser = (over: Partial<NewUser> = {}): NewUser => ({
  username: `user${Math.random().toString(36).slice(2, 10)}`,
  email: null,
  displayName: 'Test User',
  passwordHash: 'hash',
  role: 'developer',
  teamIds: [],
  mustChangePassword: false,
  ...over,
});

describe.each(harnesses)('DataStore contract: $name', (h) => {
  let store: DataStore;

  beforeAll(async () => {
    store = await h.start();
    await store.migrate();
    // Migrations must be idempotent.
    await store.migrate();
  }, 180_000);

  afterAll(async () => {
    await store?.close();
    await h.stop();
  });

  it('pings', async () => {
    expect(await store.ping()).toBe(true);
  });

  describe('users', () => {
    it('creates and finds users case-insensitively', async () => {
      const u = await store.users.create(newUser({ username: 'Alice.Smith', email: 'Alice@Example.com' }));
      expect(u.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(u.status).toBe('active');
      expect(u.mfaEnabled).toBe(false);
      expect(u.mfaRecoveryCodes).toEqual([]);
      expect(u.createdAt).toBeInstanceOf(Date);
      expect((await store.users.findByUsername('alice.smith'))?.id).toBe(u.id);
      expect((await store.users.findByEmail('ALICE@example.COM'))?.id).toBe(u.id);
      expect(await store.users.findById(u.id)).toMatchObject({ username: 'Alice.Smith', email: 'Alice@Example.com' });
    });

    it('rejects duplicate usernames and emails', async () => {
      await store.users.create(newUser({ username: 'dup-user', email: 'dup@example.com' }));
      await expect(store.users.create(newUser({ username: 'DUP-USER' }))).rejects.toMatchObject({ field: 'username' });
      await expect(store.users.create(newUser({ email: 'DUP@example.com' }))).rejects.toBeInstanceOf(DuplicateKeyError);
    });

    it('allows many users without email', async () => {
      await store.users.create(newUser({ email: null }));
      await store.users.create(newUser({ email: null }));
    });

    it('updates fields, team membership and recovery codes', async () => {
      const team = await store.teams.create({ name: `Team ${Date.now()}`, description: null });
      const u = await store.users.create(newUser());
      const lockedUntil = new Date(Date.now() + 60_000);
      const updated = await store.users.update(u.id, {
        displayName: 'Renamed',
        role: 'viewer',
        teamIds: [team.id],
        mfaRecoveryCodes: ['a', 'b'],
        lockedUntil,
        email: 'renamed@example.com',
      });
      expect(updated).toMatchObject({ displayName: 'Renamed', role: 'viewer', teamIds: [team.id], mfaRecoveryCodes: ['a', 'b'] });
      expect(updated?.lockedUntil?.getTime()).toBe(lockedUntil.getTime());
      expect((await store.users.findByEmail('renamed@example.com'))?.id).toBe(u.id);
      expect((await store.users.update(u.id, { teamIds: [] }))?.teamIds).toEqual([]);
      expect(await store.users.update('00000000-0000-0000-0000-000000000000', { displayName: 'x' })).toBeNull();
    });

    it('increments failed logins atomically', async () => {
      const u = await store.users.create(newUser());
      const results = await Promise.all(Array.from({ length: 5 }, () => store.users.incrementFailedLogins(u.id)));
      expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('lists with search, filters and paging', async () => {
      const team = await store.teams.create({ name: `Listing ${Date.now()}`, description: null });
      const prefix = `lst${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        await store.users.create(newUser({ username: `${prefix}-${i}`, role: i % 2 ? 'viewer' : 'developer', teamIds: i < 2 ? [team.id] : [] }));
      }
      const all = await store.users.list({ search: prefix, offset: 0, limit: 3 });
      expect(all.total).toBe(5);
      expect(all.items.map((u) => u.username)).toEqual([`${prefix}-0`, `${prefix}-1`, `${prefix}-2`]);
      expect((await store.users.list({ search: prefix, role: 'viewer', offset: 0, limit: 10 })).total).toBe(2);
      expect((await store.users.list({ teamId: team.id, offset: 0, limit: 10 })).total).toBe(2);
      // Regex / LIKE metacharacters are treated literally.
      expect((await store.users.list({ search: '%', offset: 0, limit: 10 })).total).toBe(0);
      expect((await store.users.list({ search: '.*', offset: 0, limit: 10 })).total).toBe(0);
    });
  });

  describe('teams', () => {
    it('creates, renames, counts members and deletes with membership cleanup', async () => {
      const t = await store.teams.create({ name: `Platform ${Date.now()}`, description: 'desc' });
      await expect(store.teams.create({ name: t.name.toUpperCase(), description: null })).rejects.toMatchObject({ field: 'name' });
      const u1 = await store.users.create(newUser({ teamIds: [t.id] }));
      await store.users.create(newUser({ teamIds: [t.id] }));
      expect((await store.teams.list()).find((x) => x.id === t.id)?.memberCount).toBe(2);
      expect((await store.teams.update(t.id, { name: `${t.name} 2`, description: null }))?.description).toBeNull();
      expect((await store.teams.findByIds([t.id])).length).toBe(1);
      expect(await store.teams.delete(t.id)).toBe(true);
      expect(await store.teams.delete(t.id)).toBe(false);
      expect((await store.users.findById(u1.id))?.teamIds).toEqual([]);
    });
  });

  describe('sessions', () => {
    it('revokes once, by family and by user', async () => {
      const u = await store.users.create(newUser());
      const familyId = crypto.randomUUID();
      const exp = new Date(Date.now() + 3600_000);
      const s1 = await store.sessions.create({ userId: u.id, tokenHash: `h1-${u.id}`, familyId, expiresAt: exp, userAgent: 'ua', ip: '1.2.3.4' });
      const s2 = await store.sessions.create({ userId: u.id, tokenHash: `h2-${u.id}`, familyId, expiresAt: exp, userAgent: null, ip: null });
      const s3 = await store.sessions.create({ userId: u.id, tokenHash: `h3-${u.id}`, familyId: crypto.randomUUID(), expiresAt: exp, userAgent: null, ip: null });

      expect((await store.sessions.findByTokenHash(`h1-${u.id}`))?.id).toBe(s1.id);
      expect(await store.sessions.revokeIfActive(s1.id)).toBe(true);
      expect(await store.sessions.revokeIfActive(s1.id)).toBe(false);
      expect(await store.sessions.revokeFamily(familyId)).toBe(1);
      expect((await store.sessions.findByTokenHash(`h2-${u.id}`))?.revokedAt).toBeInstanceOf(Date);
      expect(await store.sessions.revokeAllForUser(u.id, s3.id)).toBe(0);
      expect(await store.sessions.revokeAllForUser(u.id)).toBe(1);
      expect(s2.id).toBeTruthy();
    });

    it('deletes expired sessions', async () => {
      const u = await store.users.create(newUser());
      await store.sessions.create({ userId: u.id, tokenHash: `old-${u.id}`, familyId: crypto.randomUUID(), expiresAt: new Date(Date.now() - 1000), userAgent: null, ip: null });
      expect(await store.sessions.deleteExpired(new Date())).toBeGreaterThanOrEqual(1);
      expect(await store.sessions.findByTokenHash(`old-${u.id}`)).toBeNull();
    });
  });

  describe('audit', () => {
    it('appends and filters newest first', async () => {
      const actorId = crypto.randomUUID();
      const base = Date.now();
      await store.audit.append({ actorId, actorName: 'a', action: 'test.one', targetType: 'user', targetId: 'x', ip: null, outcome: 'success', details: { n: 1 }, at: new Date(base - 2000) });
      await store.audit.append({ actorId, actorName: 'a', action: 'test.two', targetType: null, targetId: null, ip: '::1', outcome: 'failure', details: null, at: new Date(base - 1000) });
      const page = await store.audit.list({ actorId, offset: 0, limit: 10 });
      expect(page.total).toBe(2);
      expect(page.items.map((e) => e.action)).toEqual(['test.two', 'test.one']);
      expect(page.items[1].details).toEqual({ n: 1 });
      expect((await store.audit.list({ actorId, outcome: 'failure', offset: 0, limit: 10 })).total).toBe(1);
      expect((await store.audit.list({ actorId, from: new Date(base - 1500), offset: 0, limit: 10 })).total).toBe(1);
      expect((await store.audit.list({ actorId, action: 'test.one', offset: 0, limit: 10 })).items[0].targetId).toBe('x');
    });
  });

  scanningContract(() => store);
  findingsContract(() => store);

  describe('settings', () => {
    it('round-trips JSON values and upserts', async () => {
      expect(await store.settings.get('missing')).toBeNull();
      await store.settings.set('k', { a: 1, list: [1, 2] }, null);
      await store.settings.set('k', { a: 2, list: [] }, null);
      expect((await store.settings.get('k'))?.value).toEqual({ a: 2, list: [] });
    });
  });
});
