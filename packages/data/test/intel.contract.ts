import { describe, expect, it } from 'vitest';
import { type DataStore } from '../src';

const advisory = (over: Record<string, unknown> = {}) => ({
  ecosystem: 'npm' as const,
  packageName: 'left-pad',
  affectedRange: '<1.3.1',
  fixedVersion: '1.3.1',
  severity: 'high' as const,
  cvssScore: 7.5,
  cveIds: ['CVE-2091-0001'],
  title: 'Prototype pollution in left-pad',
  summary: 'Details',
  references: ['https://example.com/a'],
  source: 'news' as const,
  sourceItemId: null,
  withdrawn: false,
  autoApproved: false,
  createdBy: null,
  ...over,
});

export function intelContract(getStore: () => DataStore): void {
  describe('threat intelligence', () => {
    it('stores news sources and keeps only unseen items per source', async () => {
      const store = getStore();
      const src = await store.intelSources.create({ name: `Feed ${Math.random()}`, url: 'https://example.com/feed.xml', enabled: true, intervalMinutes: 60 });
      expect(src).toMatchObject({ lastFetchedAt: null, lastError: null });
      const now = new Date();
      expect(await store.intelSources.update(src.id, { lastFetchedAt: now, lastNewItems: 2, lastError: null })).toMatchObject({ lastNewItems: 2 });

      const base = { sourceId: src.id, link: 'https://example.com/1', publishedAt: new Date(Date.now() - 3600_000), summary: 'text' };
      const first = await store.intelItems.insertNew([
        { ...base, guid: 'g1', title: 'lodash advisory' },
        { ...base, guid: 'g2', title: 'Other news', publishedAt: null },
      ]);
      expect(first.map((i) => i.title).sort()).toEqual(['Other news', 'lodash advisory']);
      expect(first[0]).toMatchObject({ status: 'new', candidates: [], advisoryIds: [], extraction: null });
      const second = await store.intelItems.insertNew([
        { ...base, guid: 'g1', title: 'lodash advisory (again)' },
        { ...base, guid: 'g3', title: 'Third' },
      ]);
      expect(second.map((i) => i.title)).toEqual(['Third']);

      const item = first.find((i) => i.guid === 'g1')!;
      const at = new Date();
      const cand = [{ ecosystem: 'npm' as const, packageName: 'lodash', affectedRange: '<4.17.21', fixedVersion: '4.17.21', severity: 'high' as const, cvssScore: null, cveIds: [], title: 'x', summary: '', references: [] }];
      const updated = await store.intelItems.update(item.id, { status: 'review', candidates: cand, extraction: { provider: 'anthropic', model: 'm', confidence: 0.8, rationale: 'r', at } });
      expect(updated).toMatchObject({ status: 'review', candidates: cand, extraction: { confidence: 0.8 } });
      expect(updated!.extraction!.at.getTime()).toBe(at.getTime());

      const listed = await store.intelItems.list({ sourceId: src.id, offset: 0, limit: 10 });
      expect(listed.total).toBe(3);
      // Newest first, by publication date, falling back to the fetch time.
      expect(listed.items[listed.items.length - 1].guid).not.toBe('g2');
      expect((await store.intelItems.list({ sourceId: src.id, statuses: ['review'], offset: 0, limit: 10 })).items.map((i) => i.id)).toEqual([item.id]);
      expect((await store.intelItems.list({ sourceId: src.id, search: 'LODASH', offset: 0, limit: 10 })).total).toBe(1);
      expect((await store.intelItems.listByStatus('new', 100)).some((i) => i.guid === 'g2')).toBe(true);
      const counts = await store.intelItems.countByStatus();
      expect(counts.review).toBeGreaterThanOrEqual(1);
      expect(counts.approved).toBeGreaterThanOrEqual(0);

      expect(await store.intelSources.delete(src.id)).toBe(true);
      expect(await store.intelItems.findById(item.id)).toBeNull();
    });

    it('numbers Argus advisories per year and finds active ones by package', async () => {
      const store = getStore();
      const name = `pkg-${Math.random().toString(36).slice(2)}`;
      const a = await store.advisories.create(advisory({ packageName: name }));
      const b = await store.advisories.create(advisory({ packageName: 'Newtonsoft.Json', ecosystem: 'nuget', title: `Json ${name}` }));
      expect(a.key).toMatch(new RegExp(`^ARGUS-${new Date().getUTCFullYear()}-\\d{4}$`));
      expect(Number(b.key.slice(-4))).toBe(Number(a.key.slice(-4)) + 1);
      expect(a).toMatchObject({ cveIds: ['CVE-2091-0001'], references: ['https://example.com/a'], cvssScore: 7.5, withdrawn: false });

      const found = await store.advisories.listActiveForPackages([
        { ecosystem: 'npm', name },
        { ecosystem: 'nuget', name: 'newtonsoft.json' },
        { ecosystem: 'npm', name: 'Newtonsoft.Json' },
      ]);
      expect(found.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
      expect((await store.advisories.list({ search: name, offset: 0, limit: 10 })).total).toBe(2);
      expect((await store.advisories.list({ search: 'CVE-2091-0001', offset: 0, limit: 100 })).total).toBeGreaterThanOrEqual(2);

      const active = await store.advisories.countActive();
      await store.advisories.update(a.id, { withdrawn: true });
      expect(await store.advisories.countActive()).toBe(active - 1);
      expect((await store.advisories.listActiveForPackages([{ ecosystem: 'npm', name }])).length).toBe(0);
      expect((await store.advisories.list({ search: name, withdrawn: true, offset: 0, limit: 10 })).items.map((x) => x.id)).toEqual([a.id]);
    });
  });
}
