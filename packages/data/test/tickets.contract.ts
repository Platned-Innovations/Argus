import { describe, expect, it } from 'vitest';
import { type DataStore, type NewTicket } from '../src';

async function makeRepo(store: DataStore, teamId: string | null = null) {
  const s = await store.sources.create({
    name: `t-${Math.random()}`,
    provider: 'github',
    baseUrl: null,
    scope: null,
    username: null,
    tokenEnc: 'e',
    tokenLast4: 'abcd',
    webhookSecretEnc: 'w',
    autoActivatePattern: null,
    defaultTeamId: null,
  });
  await store.repositories.syncFromSource(
    s.id,
    [{ externalId: '1', fullName: 'acme/t', name: 't', htmlUrl: null, cloneUrl: 'https://github.com/acme/t.git', defaultBranch: 'main', visibility: 'private', language: null, description: null, archived: false, lastPushedAt: null }],
    { activate: () => true, teamId, schedule: { preset: 'daily' }, firstScanAt: new Date() },
  );
  return (await store.repositories.findByExternalId(s.id, '1'))!;
}

const ticket = (repo: { id: string; sourceId: string; teamId: string | null }, over: Partial<NewTicket> = {}): NewTicket => ({
  key: `ARG-${Math.floor(Math.random() * 1e9)}`,
  repoId: repo.id,
  sourceId: repo.sourceId,
  teamId: repo.teamId,
  scanner: 'dependencies',
  groupKey: `g-${Math.random()}`,
  title: 'lodash command injection',
  description: 'desc',
  severity: 'high',
  riskScore: 75,
  status: 'open',
  assigneeId: null,
  watcherIds: [],
  labels: [],
  findingIds: [],
  openFindings: 1,
  remediation: 'Upgrade',
  dueAt: new Date(Date.now() + 86_400_000),
  slaBreachedAt: null,
  suppressionId: null,
  jira: null,
  resolvedAt: null,
  closedAt: null,
  ...over,
});

export function ticketsContract(getStore: () => DataStore): void {
  describe('tickets', () => {
    it('creates, updates (incl. JSON fields), enforces one ticket per group and lists per repository', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      const t = await store.tickets.create(ticket(repo, { groupKey: 'same', labels: ['pci'] }));
      expect(t).toMatchObject({ status: 'open', labels: ['pci'], watcherIds: [], jira: null, openFindings: 1 });
      expect(t.createdAt).toBeInstanceOf(Date);
      await expect(store.tickets.create(ticket(repo, { groupKey: 'same' }))).rejects.toThrow();

      const users = await store.users.list({ offset: 0, limit: 1 });
      const assignee = users.items[0]?.id ?? (await store.users.create({ username: `u${Date.now()}`, email: null, displayName: 'U', passwordHash: 'h', role: 'developer', teamIds: [], mustChangePassword: false })).id;
      const syncedAt = new Date();
      const u = await store.tickets.update(t.id, {
        status: 'in_progress',
        assigneeId: assignee,
        watcherIds: [assignee],
        findingIds: ['f1', 'f2'],
        jira: { key: 'PAY-1', url: 'https://jira/PAY-1', status: 'To Do', statusCategory: 'new', syncedAt },
      });
      expect(u).toMatchObject({ status: 'in_progress', assigneeId: assignee, watcherIds: [assignee], findingIds: ['f1', 'f2'], jira: { key: 'PAY-1', statusCategory: 'new' } });
      expect(u!.jira!.syncedAt?.getTime()).toBe(syncedAt.getTime());
      expect(u!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(t.lastActivityAt.getTime());
      expect((await store.tickets.listForRepo(repo.id)).map((x) => x.id)).toEqual([t.id]);
      expect((await store.tickets.listJiraLinked(100)).map((x) => x.id)).toContain(t.id);
    });

    it('filters by status, severity, assignee, SLA breach, search and team; summarises', async () => {
      const store = getStore();
      const team = await store.teams.create({ name: `TK ${Date.now()}`, description: null });
      const repo = await makeRepo(store, team.id);
      const user = await store.users.create({ username: `tk${Date.now()}`, email: null, displayName: 'TK', passwordHash: 'h', role: 'developer', teamIds: [], mustChangePassword: false });
      const past = new Date(Date.now() - 3600_000);
      const a = await store.tickets.create(ticket(repo, { severity: 'critical', riskScore: 95, dueAt: past, assigneeId: user.id, title: 'Leaked AWS key' }));
      const b = await store.tickets.create(ticket(repo, { severity: 'medium', riskScore: 50, labels: ['payments'] }));
      const c = await store.tickets.create(ticket(repo, { severity: 'low', riskScore: 20, status: 'resolved', dueAt: past }));
      const now = new Date();
      const base = { repoId: repo.id, now, offset: 0, limit: 50 };

      expect((await store.tickets.list(base)).items.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
      expect((await store.tickets.list({ ...base, statuses: ['open', 'triaged', 'in_progress', 'reopened'] })).total).toBe(2);
      expect((await store.tickets.list({ ...base, severities: ['critical'] })).total).toBe(1);
      expect((await store.tickets.list({ ...base, assigneeId: user.id })).items[0].id).toBe(a.id);
      expect((await store.tickets.list({ ...base, assigneeId: null })).total).toBe(2);
      expect((await store.tickets.list({ ...base, slaBreached: true })).items.map((t) => t.id)).toEqual([a.id]);
      expect((await store.tickets.list({ ...base, slaBreached: false })).total).toBe(2);
      expect((await store.tickets.list({ ...base, search: 'aws' })).total).toBe(1);
      expect((await store.tickets.list({ ...base, search: 'PAYMENTS' })).items[0].id).toBe(b.id);
      expect((await store.tickets.list({ ...base, search: a.key })).total).toBe(1);
      expect((await store.tickets.list({ ...base, ids: [b.id, c.id] })).total).toBe(2);
      expect((await store.tickets.list({ ...base, ids: [] })).total).toBe(0);
      expect((await store.tickets.list({ ...base, keys: [a.key, c.key] })).total).toBe(2);
      expect((await store.tickets.list({ ...base, keys: [] })).total).toBe(0);
      expect((await store.tickets.list({ ...base, visibleTeamIds: [] })).total).toBe(0);
      expect((await store.tickets.list({ ...base, visibleTeamIds: [team.id] })).total).toBe(3);

      const s = await store.tickets.summary({ visibleTeamIds: [team.id], userId: user.id, now });
      expect(s).toMatchObject({ active: 2, slaBreached: 1, assignedTo: 1, unassigned: 1, bySeverity: { critical: 1, medium: 1, low: 0 } });
      // Without a current user (weekly digests, metrics) nothing counts as "assigned to me".
      expect(await store.tickets.summary({ visibleTeamIds: [team.id], userId: null, now })).toMatchObject({ active: 2, assignedTo: 0, unassigned: 1 });

      const overdue = await store.tickets.findNewlyOverdue(now, 100);
      expect(overdue.map((t) => t.id)).toContain(a.id);
      expect(overdue.map((t) => t.id)).not.toContain(c.id);
      await store.tickets.update(a.id, { slaBreachedAt: now });
      expect((await store.tickets.findNewlyOverdue(now, 100)).map((t) => t.id)).not.toContain(a.id);

      const other = await store.teams.create({ name: `TK2 ${Date.now()}`, description: null });
      await store.tickets.setTeamForRepo(repo.id, other.id);
      expect((await store.tickets.list({ ...base, visibleTeamIds: [team.id] })).total).toBe(0);
    });

    it('records events oldest first', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      const t = await store.tickets.create(ticket(repo));
      await store.tickets.addEvent({ ticketId: t.id, type: 'created', actorId: null, actorName: null, body: null, data: { findings: 1 }, createdAt: new Date(Date.now() - 1000) });
      await store.tickets.addEvent({ ticketId: t.id, type: 'comment', actorId: null, actorName: 'Dev', body: 'Looking into it', data: null });
      const events = await store.tickets.listEvents(t.id);
      expect(events.map((e) => e.type)).toEqual(['created', 'comment']);
      expect(events[0].data).toEqual({ findings: 1 });
      expect(events[1]).toMatchObject({ body: 'Looking into it', actorName: 'Dev' });
    });

    it('links findings to tickets and lists all findings of a repository', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      await store.findings.reconcile({ repoId: repo.id, sourceId: repo.sourceId, teamId: null, runId: crypto.randomUUID(), scanners: ['secrets'], now: new Date() }, [
        {
          scanner: 'secrets',
          ruleId: 'aws',
          fingerprint: 'fp-link',
          title: 'x',
          description: null,
          severity: 'high',
          riskScore: 80,
          riskFactors: [],
          path: 'a.js',
          line: 1,
          package: null,
          advisory: null,
          secret: null,
          details: null,
          remediation: null,
          suppressionId: null,
        },
      ]);
      const [f] = await store.findings.listAllForRepo(repo.id);
      expect(f.ticketId).toBeNull();
      const t = await store.tickets.create(ticket(repo));
      await store.findings.setTicket([f.id], t.id);
      expect((await store.findings.findById(f.id))?.ticketId).toBe(t.id);
      // A later scan keeps the link.
      await store.findings.reconcile({ repoId: repo.id, sourceId: repo.sourceId, teamId: null, runId: crypto.randomUUID(), scanners: ['secrets'], now: new Date() }, [
        { ...f, riskFactors: [], suppressionId: null },
      ]);
      expect((await store.findings.findById(f.id))?.ticketId).toBe(t.id);
    });
  });

  describe('counters', () => {
    it('increments atomically', async () => {
      const store = getStore();
      const name = `c-${Math.random()}`;
      const values = await Promise.all(Array.from({ length: 10 }, () => store.counters.next(name)));
      expect(values.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });

  describe('notification channels and rules', () => {
    it('stores channels with encrypted secrets and rules', async () => {
      const store = getStore();
      const ch = await store.channels.create({ name: `SMTP ${Math.random()}`, type: 'email_smtp', enabled: true, config: { host: 'smtp.office365.com', port: 587 }, secretEnc: 'enc', secretHint: '••••word' });
      expect(await store.channels.findById(ch.id)).toMatchObject({ type: 'email_smtp', config: { host: 'smtp.office365.com', port: 587 }, lastError: null });
      const used = new Date();
      expect(await store.channels.update(ch.id, { lastUsedAt: used, lastError: 'boom', config: { host: 'smtp.gmail.com', port: 465 } })).toMatchObject({ lastError: 'boom', config: { host: 'smtp.gmail.com' } });
      expect((await store.channels.list()).some((c) => c.id === ch.id)).toBe(true);

      const rule = await store.notificationRules.create({ name: 'Critical', enabled: true, events: ['ticket_created', 'sla_breached'], minSeverity: 'critical', teamIds: [], channelIds: [ch.id], recipients: ['sec@example.com'], includeRepoRecipients: true });
      expect(await store.notificationRules.findById(rule.id)).toMatchObject({ events: ['ticket_created', 'sla_breached'], channelIds: [ch.id], recipients: ['sec@example.com'] });
      expect(await store.notificationRules.update(rule.id, { enabled: false, events: ['weekly_digest'] })).toMatchObject({ enabled: false, events: ['weekly_digest'] });
      expect((await store.notificationRules.list()).length).toBeGreaterThan(0);
      expect(await store.notificationRules.delete(rule.id)).toBe(true);
      expect(await store.channels.delete(ch.id)).toBe(true);
      expect(await store.channels.findById(ch.id)).toBeNull();
    });

    it('deleting a source removes its tickets and their events', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      const t = await store.tickets.create(ticket(repo));
      await store.tickets.addEvent({ ticketId: t.id, type: 'created', actorId: null, actorName: null, body: null, data: null });
      await store.sources.delete(repo.sourceId);
      expect(await store.tickets.findById(t.id)).toBeNull();
      expect(await store.tickets.listEvents(t.id)).toEqual([]);
    });
  });
}
