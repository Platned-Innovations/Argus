import { describe, expect, it } from 'vitest';
import { type DataStore } from '../src';

export function platformContract(getStore: () => DataStore): void {
  describe('dashboard statistics', () => {
    it('returns active rows plus recently changed ones, scoped by repository and team', async () => {
      const store = getStore();
      const team = await store.teams.create({ name: `Stats ${Date.now()}`, description: null });
      const s = await store.sources.create({ name: `st-${Math.random()}`, provider: 'github', baseUrl: null, scope: null, username: null, tokenEnc: 'e', tokenLast4: 'abcd', webhookSecretEnc: 'w', autoActivatePattern: null, defaultTeamId: null });
      await store.repositories.syncFromSource(
        s.id,
        [{ externalId: '1', fullName: 'acme/stats', name: 'stats', htmlUrl: null, cloneUrl: 'https://github.com/acme/stats.git', defaultBranch: 'main', visibility: 'private', language: null, description: null, archived: false, lastPushedAt: null }],
        { activate: () => true, teamId: team.id, schedule: { preset: 'daily' }, firstScanAt: new Date() },
      );
      const repo = (await store.repositories.findByExternalId(s.id, '1'))!;
      const base = { description: null, riskFactors: [], path: 'a', line: null, package: null, advisory: null, secret: null, remediation: null, suppressionId: null };
      const ctx = (scanners: ('secrets' | 'certificates')[]) => ({ repoId: repo.id, sourceId: s.id, teamId: team.id, runId: crypto.randomUUID(), scanners, now: new Date() });
      await store.findings.reconcile(ctx(['secrets', 'certificates']), [
        { ...base, scanner: 'secrets', ruleId: 'r1', fingerprint: 'st-1', title: 'Open secret', severity: 'high', riskScore: 80, details: null },
        { ...base, scanner: 'certificates', ruleId: 'cert', fingerprint: 'st-2', title: 'Cert', severity: 'medium', riskScore: 50, details: { validTo: '2026-12-01T00:00:00.000Z' } },
      ]);
      // A second scan without st-1 marks it fixed (recently, so it is still included).
      await store.findings.reconcile(ctx(['secrets', 'certificates']), [{ ...base, scanner: 'certificates', ruleId: 'cert', fingerprint: 'st-2', title: 'Cert', severity: 'medium', riskScore: 50, details: { validTo: '2026-12-01T00:00:00.000Z' } }]);

      const rows = await store.findings.statsRows({ repoId: repo.id, since: new Date(Date.now() - 86_400_000) });
      expect(rows.map((r) => [r.title, r.status]).sort()).toEqual([
        ['Cert', 'open'],
        ['Open secret', 'fixed'],
      ]);
      expect(rows.find((r) => r.title === 'Cert')).toMatchObject({ scanner: 'certificates', riskScore: 50, details: { validTo: '2026-12-01T00:00:00.000Z' }, fixedAt: null });
      expect(rows.find((r) => r.status === 'fixed')!.fixedAt).toBeInstanceOf(Date);
      // Fixed before "since": only the open one remains.
      expect((await store.findings.statsRows({ repoId: repo.id, since: new Date(Date.now() + 86_400_000) })).map((r) => r.title)).toEqual(['Cert']);
      expect(await store.findings.statsRows({ repoId: repo.id, visibleTeamIds: [], since: new Date(0) })).toEqual([]);
      expect((await store.findings.statsRows({ teamId: team.id, since: new Date(0) })).length).toBe(2);

      await store.tickets.create({
        key: `ST-${Math.random()}`, repoId: repo.id, sourceId: s.id, teamId: team.id, scanner: 'secrets', groupKey: 'st', title: 't', description: null, severity: 'high', riskScore: 80, status: 'resolved',
        assigneeId: null, watcherIds: [], labels: [], findingIds: [], openFindings: 0, remediation: null, dueAt: new Date(Date.now() + 86_400_000), slaBreachedAt: null, suppressionId: null, jira: null, resolvedAt: new Date(), closedAt: null,
      });
      const tickets = await store.tickets.statsRows({ repoId: repo.id, since: new Date(Date.now() - 86_400_000) });
      expect(tickets).toEqual([expect.objectContaining({ severity: 'high', status: 'resolved' })]);
      expect(tickets[0].resolvedAt).toBeInstanceOf(Date);
      expect(await store.tickets.statsRows({ repoId: repo.id, visibleTeamIds: [], since: new Date(0) })).toEqual([]);
    });
  });

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
