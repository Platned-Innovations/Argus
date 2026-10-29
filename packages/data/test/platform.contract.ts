import { describe, expect, it } from 'vitest';
import { type DataStore } from '../src';

export function platformContract(getStore: () => DataStore): void {
  describe('API tokens', () => {
    it('finds tokens by hash, lists them per user, records use and revokes', async () => {
      const store = getStore();
      const user = await store.users.create({ username: `tok${Date.now()}`, email: null, displayName: 'Tok', passwordHash: 'h', role: 'developer', teamIds: [], mustChangePassword: false });
      const expiresAt = new Date(Date.now() + 86_400_000);
      const a = await store.apiTokens.create({ userId: user.id, name: 'CI', tokenHash: `hash-a-${user.id}`, prefix: 'argus_pat_ab', scopes: ['findings:read', 'repos:read'], expiresAt });
      const b = await store.apiTokens.create({ userId: user.id, name: 'Reports', tokenHash: `hash-b-${user.id}`, prefix: 'argus_pat_cd', scopes: ['reports:read'], expiresAt });
      expect(a).toMatchObject({ scopes: ['findings:read', 'repos:read'], revokedAt: null, lastUsedAt: null });
      expect((await store.apiTokens.findByHash(`hash-a-${user.id}`))?.id).toBe(a.id);
      expect(await store.apiTokens.findByHash('nope')).toBeNull();
      await expect(store.apiTokens.create({ userId: user.id, name: 'Dup', tokenHash: `hash-a-${user.id}`, prefix: 'x', scopes: [], expiresAt })).rejects.toThrow();

      const listed = await store.apiTokens.listForUser(user.id);
      expect(listed.map((t) => t.name).sort()).toEqual(['CI', 'Reports']);
      expect((await store.apiTokens.listAll()).some((t) => t.id === b.id)).toBe(true);

      const used = new Date();
      await store.apiTokens.touch(a.id, used, '10.0.0.1');
      expect(await store.apiTokens.findById(a.id)).toMatchObject({ lastUsedIp: '10.0.0.1' });
      expect((await store.apiTokens.findById(a.id))!.lastUsedAt!.getTime()).toBe(used.getTime());

      expect(await store.apiTokens.revoke(a.id)).toBe(true);
      expect(await store.apiTokens.revoke(a.id)).toBe(false);
      expect(await store.apiTokens.revokeAllForUser(user.id)).toBe(1);
      expect((await store.apiTokens.listForUser(user.id)).every((t) => t.revokedAt)).toBe(true);
    });
  });
}
