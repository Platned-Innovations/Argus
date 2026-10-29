import { describe, expect, it } from 'vitest';
import { type DataStore, type Dependency, type ObservedFinding, type ReconcileContext } from '../src';

const observed = (fp: string, over: Partial<ObservedFinding> = {}): ObservedFinding => ({
  scanner: 'dependencies',
  ruleId: `GHSA-${fp}`,
  fingerprint: fp,
  title: `Issue ${fp}`,
  description: null,
  severity: 'high',
  riskScore: 75,
  riskFactors: [{ key: 'base', label: 'CVSS 7.5', points: 75 }],
  path: 'package-lock.json',
  line: null,
  package: { ecosystem: 'npm', name: `pkg-${fp}`, version: '1.0.0', direct: true, dev: false, fixedVersion: '1.0.1' },
  advisory: { id: `GHSA-${fp}`, aliases: ['CVE-2026-0001'], summary: 's', cvssScore: 7.5, cvssVector: null, epss: 0.1, kev: false, url: null, published: null },
  secret: null,
  details: { a: 1 },
  remediation: 'Upgrade',
  suppressionId: null,
  ...over,
});

const dep = (repoId: string, name: string, over: Partial<Dependency> = {}): Dependency => ({
  repoId,
  teamId: null,
  ecosystem: 'npm',
  name,
  version: '1.0.0',
  direct: true,
  dev: false,
  license: 'MIT',
  manifestPath: 'package-lock.json',
  latestVersion: '2.0.0',
  deprecated: null,
  vulnerabilities: 0,
  ...over,
});

async function makeRepo(store: DataStore, teamId: string | null = null) {
  const s = await store.sources.create({
    name: `f-${Math.random()}`,
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
    [
      {
        externalId: '1',
        fullName: 'acme/x',
        name: 'x',
        htmlUrl: null,
        cloneUrl: 'https://github.com/acme/x.git',
        defaultBranch: 'main',
        visibility: 'private',
        language: null,
        description: null,
        archived: false,
        lastPushedAt: null,
      },
    ],
    { activate: () => true, teamId, schedule: { preset: 'daily' }, firstScanAt: new Date() },
  );
  return (await store.repositories.findByExternalId(s.id, '1'))!;
}

export function findingsContract(getStore: () => DataStore): void {
  describe('findings', () => {
    it('reconciles: opens new, refreshes seen, fixes missing for completed scanners only, reopens returning', async () => {
      const store = getStore();
      const team = await store.teams.create({ name: `F ${Date.now()}`, description: null });
      const repo = await makeRepo(store, team.id);
      const ctx = (runId: string, scanners: ReconcileContext['scanners'] = ['dependencies', 'secrets']): ReconcileContext => ({
        repoId: repo.id,
        sourceId: repo.sourceId,
        teamId: team.id,
        runId,
        scanners,
        now: new Date(),
      });
      const run1 = crypto.randomUUID();
      const secret = observed('s1', { scanner: 'secrets', ruleId: 'aws', package: null, advisory: null, secret: { type: 'aws', preview: 'AKIA…', hash: 'h' }, severity: 'critical', riskScore: 95 });
      expect(await store.findings.reconcile(ctx(run1), [observed('a'), observed('b'), observed('a'), secret])).toEqual({ opened: 3, reopened: 0, fixed: 0, unchanged: 0 });

      const list = await store.findings.list({ repoId: repo.id, offset: 0, limit: 10 });
      expect(list.total).toBe(3);
      expect(list.items[0].fingerprint).toBe('s1'); // highest risk first
      const a = list.items.find((f) => f.fingerprint === 'a')!;
      expect(a).toMatchObject({ status: 'open', teamId: team.id, firstRunId: run1, package: { name: 'pkg-a', fixedVersion: '1.0.1' }, advisory: { aliases: ['CVE-2026-0001'] }, details: { a: 1 } });
      expect(a.riskFactors).toEqual([{ key: 'base', label: 'CVSS 7.5', points: 75 }]);

      // Second run: "b" gone (dependencies ran), secret not re-reported but secrets scanner did not run -> stays open.
      const run2 = crypto.randomUUID();
      expect(await store.findings.reconcile(ctx(run2, ['dependencies']), [observed('a', { riskScore: 80 })])).toEqual({ opened: 0, reopened: 0, fixed: 1, unchanged: 1 });
      const b = (await store.findings.list({ repoId: repo.id, status: 'fixed', offset: 0, limit: 10 })).items[0];
      expect(b.fingerprint).toBe('b');
      expect(b.fixedAt).toBeInstanceOf(Date);
      expect((await store.findings.findById(a.id))).toMatchObject({ riskScore: 80, lastRunId: run2, firstRunId: run1 });
      expect((await store.findings.list({ repoId: repo.id, status: 'open', offset: 0, limit: 10 })).total).toBe(2);

      // Third run: "b" is back -> reopened; "a" now suppressed by the scan.
      const r3 = await store.findings.reconcile(ctx(crypto.randomUUID(), ['dependencies']), [observed('a', { suppressionId: crypto.randomUUID() }), observed('b')]);
      expect(r3).toEqual({ opened: 0, reopened: 1, fixed: 0, unchanged: 1 });
      expect((await store.findings.findById(b.id))).toMatchObject({ status: 'open', fixedAt: null });
      expect((await store.findings.findById(a.id))?.status).toBe('suppressed');
    });

    it('filters, searches, scopes and summarises', async () => {
      const store = getStore();
      const t1 = await store.teams.create({ name: `FS1 ${Date.now()}`, description: null });
      const repo = await makeRepo(store, t1.id);
      const ctx: ReconcileContext = { repoId: repo.id, sourceId: repo.sourceId, teamId: t1.id, runId: crypto.randomUUID(), scanners: ['dependencies', 'secrets'], now: new Date() };
      await store.findings.reconcile(ctx, [
        observed('c1', { severity: 'critical', riskScore: 95 }),
        observed('h1', { severity: 'high', riskScore: 75, path: 'web/package-lock.json' }),
        observed('m1', { severity: 'medium', riskScore: 45, scanner: 'secrets', package: null }),
        observed('x1', { severity: 'low', riskScore: 20, suppressionId: crypto.randomUUID() }),
      ]);
      const base = { repoId: repo.id, offset: 0, limit: 50 };
      expect((await store.findings.list({ ...base, severities: ['critical', 'high'] })).total).toBe(2);
      expect((await store.findings.list({ ...base, scanner: 'secrets' })).total).toBe(1);
      expect((await store.findings.list({ ...base, search: 'pkg-h1' })).total).toBe(1);
      expect((await store.findings.list({ ...base, search: 'WEB/' })).total).toBe(1);
      expect((await store.findings.list({ ...base, search: '%' })).total).toBe(0);
      expect((await store.findings.list({ ...base, visibleTeamIds: [] })).total).toBe(0);
      expect((await store.findings.list({ ...base, visibleTeamIds: [crypto.randomUUID()] })).total).toBe(0);
      expect((await store.findings.list({ ...base, visibleTeamIds: [t1.id] })).total).toBe(4);

      await store.findings.reconcile({ ...ctx, runId: crypto.randomUUID(), now: new Date() }, [observed('c1'), observed('m1', { scanner: 'secrets', package: null, severity: 'medium' }), observed('x1', { suppressionId: crypto.randomUUID() })]);
      const summary = await store.findings.summary({ repoId: repo.id, fixedSince: new Date(Date.now() - 60_000) });
      expect(summary.open).toEqual({ critical: 0, high: 1, medium: 1, low: 0, info: 0 }); // c1 now high (default), h1 fixed
      expect(summary.suppressed).toBe(1);
      expect(summary.fixedSince).toBe(1);
      expect(summary.byScanner).toMatchObject({ dependencies: 1, secrets: 1 });
      expect((await store.findings.summary({ visibleTeamIds: [], fixedSince: new Date() })).suppressed).toBe(0);

      // Moving the repository to another team moves its findings too.
      const t2 = await store.teams.create({ name: `FS2 ${Date.now()}`, description: null });
      await store.findings.setTeamForRepo(repo.id, t2.id);
      expect((await store.findings.list({ ...base, visibleTeamIds: [t1.id] })).total).toBe(0);
      expect((await store.findings.list({ ...base, visibleTeamIds: [t2.id] })).total).toBe(4);

      const one = (await store.findings.list({ ...base, status: 'open' })).items[0];
      const supId = crypto.randomUUID();
      expect(await store.findings.update(one.id, { status: 'suppressed', suppressionId: supId })).toMatchObject({ status: 'suppressed', suppressionId: supId });
    });
  });

  describe('dependencies', () => {
    it('replaces inventory, lists with filters, searches across repositories by name and team', async () => {
      const store = getStore();
      const team = await store.teams.create({ name: `D ${Date.now()}`, description: null });
      const r1 = await makeRepo(store, team.id);
      const r2 = await makeRepo(store, null);
      await store.dependencies.replaceForRepo(r1.id, [dep(r1.id, 'Lodash', { teamId: team.id, vulnerabilities: 2 }), dep(r1.id, 'react', { teamId: team.id, dev: true, direct: false })]);
      await store.dependencies.replaceForRepo(r2.id, [dep(r2.id, 'lodash', { version: '4.17.21' }), dep(r2.id, 'Newtonsoft.Json', { ecosystem: 'nuget', manifestPath: 'App.csproj' })]);

      const list = await store.dependencies.listForRepo(r1.id, { offset: 0, limit: 10 });
      expect(list.total).toBe(2);
      expect(list.items[0]).toMatchObject({ name: 'Lodash', vulnerabilities: 2, license: 'MIT', latestVersion: '2.0.0' });
      expect((await store.dependencies.listForRepo(r1.id, { vulnerableOnly: true, offset: 0, limit: 10 })).total).toBe(1);
      expect((await store.dependencies.listForRepo(r1.id, { search: 'REA', offset: 0, limit: 10 })).total).toBe(1);
      expect((await store.dependencies.listForRepo(r2.id, { ecosystem: 'nuget', offset: 0, limit: 10 })).items[0].name).toBe('Newtonsoft.Json');

      const all = await store.dependencies.search({ name: 'LODASH', limit: 100 });
      expect(all.filter((d) => [r1.id, r2.id].includes(d.repoId)).map((d) => d.version).sort()).toEqual(['1.0.0', '4.17.21']);
      expect((await store.dependencies.search({ name: 'lodash', visibleTeamIds: [team.id], limit: 100 })).map((d) => d.repoId)).toEqual([r1.id]);
      expect(await store.dependencies.search({ name: 'lodash', visibleTeamIds: [], limit: 100 })).toEqual([]);
      expect((await store.dependencies.search({ name: 'lodash', ecosystem: 'nuget', limit: 100 })).length).toBe(0);

      await store.dependencies.setTeamForRepo(r2.id, team.id);
      expect((await store.dependencies.search({ name: 'lodash', visibleTeamIds: [team.id], limit: 100 })).length).toBe(2);
      await store.dependencies.replaceForRepo(r1.id, []);
      expect((await store.dependencies.listForRepo(r1.id, { offset: 0, limit: 10 })).total).toBe(0);
    });
  });

  describe('suppressions', () => {
    it('lists global and repository suppressions, ignoring expired ones when applying', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      const other = await makeRepo(store);
      const base = { scanner: null, ruleId: null, pathPattern: null, packageName: null, createdBy: null, createdByName: 'admin' };
      const global = await store.suppressions.create({ ...base, repoId: null, ruleId: 'GHSA-global', reason: 'Not applicable to us', expiresAt: null });
      const mine = await store.suppressions.create({ ...base, repoId: repo.id, pathPattern: 'test/**', reason: 'Test fixtures', expiresAt: new Date(Date.now() + 86_400_000) });
      await store.suppressions.create({ ...base, repoId: repo.id, packageName: 'old', reason: 'Expired one', expiresAt: new Date(Date.now() - 1000) });
      await store.suppressions.create({ ...base, repoId: other.id, scanner: 'licenses', reason: 'Other repository', expiresAt: null });

      const applicable = (await store.suppressions.listApplicable(repo.id, new Date())).map((s) => s.id);
      expect(applicable).toContain(global.id);
      expect(applicable).toContain(mine.id);
      expect(applicable).toHaveLength(2);
      expect((await store.suppressions.list({ repoId: repo.id })).filter((s) => s.repoId === repo.id)).toHaveLength(2);
      expect(await store.suppressions.findById(mine.id)).toMatchObject({ pathPattern: 'test/**', createdByName: 'admin' });
      expect(await store.suppressions.delete(mine.id)).toBe(true);
      expect(await store.suppressions.findById(mine.id)).toBeNull();
    });

    it('cascades findings, dependencies and suppressions when a source is deleted', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      await store.findings.reconcile({ repoId: repo.id, sourceId: repo.sourceId, teamId: null, runId: crypto.randomUUID(), scanners: ['dependencies'], now: new Date() }, [observed('del')]);
      await store.dependencies.replaceForRepo(repo.id, [dep(repo.id, 'gone')]);
      const s = await store.suppressions.create({ repoId: repo.id, scanner: 'secrets', ruleId: null, pathPattern: null, packageName: null, reason: 'cascade test', expiresAt: null, createdBy: null, createdByName: null });
      await store.sources.delete(repo.sourceId);
      expect((await store.findings.list({ repoId: repo.id, offset: 0, limit: 10 })).total).toBe(0);
      expect((await store.dependencies.listForRepo(repo.id, { offset: 0, limit: 10 })).total).toBe(0);
      expect(await store.suppressions.findById(s.id)).toBeNull();
    });
  });

  describe('repositories (phase 2 fields)', () => {
    it('stores disabled scanners and moves scan runs with the team', async () => {
      const store = getStore();
      const repo = await makeRepo(store);
      expect(repo.disabledScanners).toEqual([]);
      expect((await store.repositories.update(repo.id, { disabledScanners: ['licenses', 'secrets'] }))?.disabledScanners).toEqual(['licenses', 'secrets']);
      const team = await store.teams.create({ name: `R ${Date.now()}`, description: null });
      await store.scanRuns.create({ repoId: repo.id, sourceId: repo.sourceId, teamId: null, trigger: 'manual', requestedBy: null, branch: null });
      await store.scanRuns.setTeamForRepo(repo.id, team.id);
      expect((await store.scanRuns.list({ repoId: repo.id, visibleTeamIds: [team.id], offset: 0, limit: 10 })).total).toBe(1);
    });
  });

  describe('intel cache', () => {
    it('stores, batch-reads, overwrites and expires entries', async () => {
      const store = getStore();
      const k = `k-${Math.random()}`;
      expect(await store.cache.get(k)).toBeNull();
      await store.cache.set(k, { cves: ['CVE-1'] }, 60_000);
      await store.cache.set(`${k}-2`, [1, 2, 3], 1);
      await store.cache.set(k, { cves: ['CVE-2'] }, 60_000);
      const one = await store.cache.get<{ cves: string[] }>(k);
      expect(one?.value).toEqual({ cves: ['CVE-2'] });
      expect(one!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const many = await store.cache.getMany([k, `${k}-2`, 'missing']);
      expect([...many.keys()].sort()).toEqual([k, `${k}-2`].sort());
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.cache.deleteExpired(new Date())).toBeGreaterThanOrEqual(1);
      expect(await store.cache.get(`${k}-2`)).toBeNull();
    });
  });
}
