import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type DataStore } from '../src';

async function makeRepo(store: DataStore) {
  const s = await store.sources.create({
    name: `ai-${Math.random()}`,
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
    [{ externalId: '1', fullName: 'acme/ai', name: 'ai', htmlUrl: null, cloneUrl: 'https://github.com/acme/ai.git', defaultBranch: 'main', visibility: 'private', language: null, description: null, archived: false, lastPushedAt: null }],
    { activate: () => true, teamId: null, schedule: { preset: 'daily' }, firstScanAt: new Date() },
  );
  return (await store.repositories.findByExternalId(s.id, '1'))!;
}

export function aiContract(getStore: () => DataStore): void {
  describe('ai', () => {
    it('repositories allow AI by default and can opt out', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      expect(repo.aiEnabled).toBe(true);
      expect((await store.repositories.update(repo.id, { aiEnabled: false }))?.aiEnabled).toBe(false);
    });

    it('records usage and summarises it per provider, model and use case within a period', async () => {
      const store = getStore();
      // A far-future month keeps this test independent of other rows.
      const from = new Date(Date.UTC(2091, 0, 1));
      const to = new Date(Date.UTC(2091, 1, 1));
      const base = { provider: 'anthropic', model: 'claude-opus-5-5', useCase: 'remediation', userId: null, repoId: null } as const;
      await store.aiUsage.record({ ...base, at: new Date(Date.UTC(2091, 0, 5)), inputTokens: 1000, outputTokens: 200, costUsd: 0.008, outcome: 'ok' });
      await store.aiUsage.record({ ...base, at: new Date(Date.UTC(2091, 0, 6)), inputTokens: 500, outputTokens: 0, costUsd: 0.002, outcome: 'invalid_output' });
      await store.aiUsage.record({ ...base, provider: 'openai', model: 'gpt-6.1-sol', at: new Date(Date.UTC(2091, 0, 7)), inputTokens: 10, outputTokens: 10, costUsd: 0.5, outcome: 'ok' });
      await store.aiUsage.record({ ...base, at: new Date(Date.UTC(2091, 1, 1)), inputTokens: 1, outputTokens: 1, costUsd: 99, outcome: 'ok' });

      const rows = await store.aiUsage.summary(from, to);
      expect(rows).toEqual([
        { provider: 'anthropic', model: 'claude-opus-5-5', useCase: 'remediation', requests: 2, failures: 1, inputTokens: 1500, outputTokens: 200, costUsd: expect.closeTo(0.01, 6) },
        { provider: 'openai', model: 'gpt-6.1-sol', useCase: 'remediation', requests: 1, failures: 0, inputTokens: 10, outputTokens: 10, costUsd: expect.closeTo(0.5, 6) },
      ]);
      expect(await store.aiUsage.totalCost(from, to)).toBeCloseTo(0.51, 6);
      expect(await store.aiUsage.totalCost(new Date(Date.UTC(2092, 0, 1)), new Date(Date.UTC(2092, 1, 1)))).toBe(0);
    });

    it('keeps one insight per subject and use case, and removes insights with the source', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      const subjectId = randomUUID();
      const base = { subjectType: 'ticket', subjectId, repoId: repo.id, useCase: 'remediation', provider: 'anthropic', model: 'claude-opus-5-5', redactions: 0, createdBy: null } as const;
      const first = await store.aiInsights.put({ ...base, output: { summary: 'first' } });
      const second = await store.aiInsights.put({ ...base, output: { summary: 'second', steps: ['a'] }, redactions: 2 });
      expect(second.id).toBe(first.id);
      expect(await store.aiInsights.find('ticket', subjectId, 'remediation')).toMatchObject({ output: { summary: 'second', steps: ['a'] }, redactions: 2 });
      expect(await store.aiInsights.find('ticket', subjectId, 'ticket_draft')).toBeNull();

      const findingId = randomUUID();
      await store.aiInsights.put({ ...base, subjectType: 'finding', subjectId: findingId, useCase: 'secret_triage', output: { verdict: 'uncertain' } });
      expect((await store.aiInsights.listForSubjects('finding', [findingId, randomUUID()])).map((i) => i.output)).toEqual([{ verdict: 'uncertain' }]);
      expect(await store.aiInsights.listForSubjects('finding', [])).toEqual([]);

      await store.sources.delete(repo.sourceId);
      expect(await store.aiInsights.find('ticket', subjectId, 'remediation')).toBeNull();
    });
  });
}
