import { describe, expect, it } from 'vitest';
import { type DataStore } from '../src';

export function platformContract(getStore: () => DataStore): void {
  describe('retention', () => {
    it('removes only old records: audit entries, AI usage, settled news items', async () => {
      const store = getStore();
      const old = new Date(Date.UTC(2001, 0, 1));
      const cutoff = new Date(Date.UTC(2002, 0, 1));
      const tag = `ret-${Math.random().toString(36).slice(2)}`;
      // Audit: append now, then backdate is not possible through the API, so delete with a cutoff in the future
      // and check only entries before it go.
      await store.audit.append({ action: tag, actorId: null, actorName: null, targetType: null, targetId: null, outcome: 'success', details: null, ip: null });
      expect(await store.audit.deleteBefore(old)).toBe(0);
      expect((await store.audit.list({ action: tag, offset: 0, limit: 10 })).total).toBe(1);

      await store.aiUsage.record({ provider: 'openai', model: 'm', useCase: 'remediation', userId: null, repoId: null, inputTokens: 1, outputTokens: 1, costUsd: 0, outcome: 'ok', at: old });
      await store.aiUsage.record({ provider: 'openai', model: 'm', useCase: 'remediation', userId: null, repoId: null, inputTokens: 1, outputTokens: 1, costUsd: 0, outcome: 'ok', at: new Date(Date.UTC(2003, 0, 1)) });
      expect(await store.aiUsage.deleteBefore(cutoff)).toBe(1);
      expect((await store.aiUsage.summary(new Date(Date.UTC(2003, 0, 1)), new Date(Date.UTC(2003, 1, 1))))[0].requests).toBe(1);

      const src = await store.intelSources.create({ name: tag, url: 'https://example.com/f', enabled: false, intervalMinutes: 60 });
      const [a, b] = await store.intelItems.insertNew([
        { sourceId: src.id, guid: `${tag}-a`, title: 'settled', link: null, publishedAt: null, summary: '' },
        { sourceId: src.id, guid: `${tag}-b`, title: 'awaiting review', link: null, publishedAt: null, summary: '' },
      ]);
      await store.intelItems.update(a.id, { status: 'no_match' });
      await store.intelItems.update(b.id, { status: 'review' });
      expect(await store.intelItems.deleteSettledBefore(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(1);
      expect(await store.intelItems.findById(a.id)).toBeNull();
      expect(await store.intelItems.findById(b.id)).not.toBeNull();
      expect(await store.findings.deleteFixedBefore(old)).toBe(0);
    });
  });

  describe('credential inventory', () => {
    it('stores credentials, lists by expiry with filters, tracks imports and clears a deleted team', async () => {
      const store = getStore();
      const team = await store.teams.create({ name: `Cred ${Date.now()}`, description: null });
      const tag = Math.random().toString(36).slice(2, 8);
      const base = { kind: 'api_key' as const, system: 'Stripe', owner: 'payments@acme.com', teamId: team.id, notes: '', notifyEmails: ['ops@acme.com'], source: 'manual' as const, externalId: null, archived: false, createdBy: null };
      const later = await store.credentials.create({ ...base, name: `Payments key (prod) ${tag}`, expiresAt: new Date(Date.now() + 60 * 86_400_000) });
      const soon = await store.credentials.create({ ...base, name: `Webhook secret ${tag}`, system: 'GitHub', expiresAt: new Date(Date.now() + 5 * 86_400_000) });
      const imported = await store.credentials.create({ ...base, name: `App secret ${tag}`, kind: 'client_secret', teamId: null, source: 'entra', externalId: `app-${tag}:key-1`, expiresAt: new Date(Date.now() + 10 * 86_400_000) });
      expect(later).toMatchObject({ notifyEmails: ['ops@acme.com'], lastNoticeDays: null, archived: false });
      await expect(store.credentials.create({ ...base, name: 'dup', source: 'entra', externalId: `app-${tag}:key-1`, expiresAt: new Date() })).rejects.toThrow();

      const mine = await store.credentials.list({ search: tag, offset: 0, limit: 10 });
      expect(mine.items.map((c) => c.id)).toEqual([soon.id, imported.id, later.id]);
      expect((await store.credentials.list({ search: tag, expiresBefore: new Date(Date.now() + 30 * 86_400_000), offset: 0, limit: 10 })).total).toBe(2);
      // Organisation-wide (no team) credentials are not in a team-restricted view.
      expect((await store.credentials.list({ search: tag, visibleTeamIds: [team.id], offset: 0, limit: 10 })).total).toBe(2);
      expect((await store.credentials.list({ search: 'GITHUB', offset: 0, limit: 100 })).items.some((c) => c.id === soon.id)).toBe(true);
      // Regex and LIKE metacharacters are matched literally.
      expect((await store.credentials.list({ search: '(prod) ' + tag, offset: 0, limit: 10 })).items.map((c) => c.id)).toEqual([later.id]);
      expect((await store.credentials.list({ search: '%', offset: 0, limit: 10 })).total).toBe(0);

      expect(await store.credentials.update(soon.id, { lastNoticeDays: 7, notifyEmails: [], archived: true })).toMatchObject({ lastNoticeDays: 7, notifyEmails: [], archived: true });
      expect((await store.credentials.list({ search: tag, archived: false, offset: 0, limit: 10 })).total).toBe(2);
      expect((await store.credentials.listBySource('entra')).some((c) => c.externalId === `app-${tag}:key-1`)).toBe(true);

      await store.teams.delete(team.id);
      expect((await store.credentials.findById(later.id))?.teamId).toBeNull();
      expect(await store.credentials.delete(later.id)).toBe(true);
      expect(await store.credentials.findById(later.id)).toBeNull();
    });
  });

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

  describe('saved views', () => {
    it('lists own and shared views per list, sorted by name, and counts per user', async () => {
      const store = getStore();
      const mk = (u: string) => store.users.create({ username: `${u}${Date.now()}`, email: null, displayName: u, passwordHash: 'h', role: 'developer', teamIds: [], mustChangePassword: false });
      const [alice, bob] = [await mk('alice'), await mk('bob')];
      const mine = await store.savedViews.create({ userId: alice.id, page: 'tickets', name: 'my criticals', query: 'severity=critical', shared: false });
      await store.savedViews.create({ userId: alice.id, page: 'findings', name: 'secrets', query: 'scanner=secrets', shared: false });
      const team = await store.savedViews.create({ userId: bob.id, page: 'tickets', name: 'Overdue', query: 'sla=breached', shared: true });
      await store.savedViews.create({ userId: bob.id, page: 'tickets', name: 'bob only', query: '', shared: false });

      expect(mine).toMatchObject({ userId: alice.id, page: 'tickets', name: 'my criticals', query: 'severity=critical', shared: false });
      const forAlice = (await store.savedViews.listVisible(alice.id, 'tickets')).filter((v) => [alice.id, bob.id].includes(v.userId));
      expect(forAlice.map((v) => v.name)).toEqual(['my criticals', 'Overdue']);
      expect((await store.savedViews.listVisible(bob.id, 'tickets')).filter((v) => v.userId === alice.id)).toEqual([]);
      expect(await store.savedViews.countForUser(alice.id, 'tickets')).toBe(1);
      expect(await store.savedViews.countForUser(bob.id, 'tickets')).toBe(2);

      expect(await store.savedViews.delete(team.id)).toBe(true);
      expect(await store.savedViews.delete(team.id)).toBe(false);
      expect(await store.savedViews.findById(team.id)).toBeNull();
    });
  });
}
