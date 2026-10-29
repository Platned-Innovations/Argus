import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { type AdvisoryDto, type FindingDto, type IntelItemDto, type IntelOverviewDto, type IntelSourceDto, type Paged, type RepositoryDto, type TicketDto } from '@argus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { AppConfig } from '../../src/config/app-config';
import { BASE_TEST_ENV, Client, dbHarnesses, waitFor } from './helpers';
import { type AiCall, aiRoutes } from './mock-ai';
import { createGitRepo, type FixtureRepo, type MockGitHub, startMockGitHub } from './mock-github';
import { intelEnv, intelRoutes } from './mock-intel';

const TOKEN = 'ghp_e2eIntelToken0123456789ab';
const NEW_GHSA = 'GHSA-new0-0000-0000';

function lock() {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'shop', dependencies: { lodash: '^4.17.20', 'left-pad': '1.1.0', minimist: '1.2.5', ms: '2.1.2' } },
      'node_modules/lodash': { version: '4.17.20', license: 'MIT' },
      'node_modules/left-pad': { version: '1.1.0', license: 'MIT' },
      'node_modules/minimist': { version: '1.2.5', license: 'MIT' },
      'node_modules/ms': { version: '2.1.2', license: 'MIT' },
    },
  });
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Sec news</title>
<item><guid>item-1</guid><title>Prototype pollution in minimist</title><link>https://news.example/minimist</link><pubDate>Tue, 27 Oct 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>minimist before <b>1.2.6</b> is vulnerable to prototype pollution (CVE-2021-44906).</p><script>alert(1)</script>]]></description></item>
<item><guid>item-2</guid><title>Release notes for our product</title><link>https://news.example/release</link><description>Nothing security related.</description></item>
</channel></rss>`;

const harnesses = dbHarnesses();

describe.each(harnesses)('threat intelligence e2e: $name', (h) => {
  let app: INestApplication;
  let admin: Client;
  let dev: Client;
  let mock: MockGitHub;
  let fixture: FixtureRepo;
  let tmp: string;
  let repo: RepositoryDto;
  const calls: AiCall[] = [];
  const hooks: { event: string; title: string }[] = [];
  const state = { newVuln: false, nvdCalls: 0 };

  const findings = async () => ((await admin.call('get', `/api/v1/findings?repoId=${repo.id}&pageSize=100`)).body as Paged<FindingDto>).items;
  const overview = async () => (await admin.call('get', '/api/v1/intel/overview')).body as IntelOverviewDto;
  const rematchAfter = async (at: string | null, trigger?: string) =>
    waitFor(
      async () => {
        const o = await overview();
        return o.lastRematch && o.lastRematch.at !== at && (!trigger || o.lastRematch.trigger === trigger) ? o.lastRematch : null;
      },
      { what: 'rematch', timeoutMs: 60_000 },
    );

  /** Extra OSV data (a vulnerability published after the first scan) and an NVD record for it. */
  const extra = (req: IncomingMessage, url: URL, body: string, res: ServerResponse): boolean => {
    const json = (data: unknown, status = 200) => (res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)), true);
    if (url.pathname === '/feeds/sec.xml') return (res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(FEED), true);
    if (url.pathname === '/feeds/moved') return (res.writeHead(301, { location: 'http://plain.example/feed' }).end(), true);
    if (url.pathname === '/hook') {
      hooks.push(JSON.parse(body));
      return json({ ok: true });
    }
    if (url.pathname === '/nvd') {
      state.nvdCalls++;
      return json({ vulnerabilities: url.searchParams.get('cveId') === 'CVE-2026-0042' ? [{ cve: { metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' } }] } } }] : [] });
    }
    if (state.newVuln && url.pathname === '/intel/osv/v1/querybatch') {
      const { queries } = JSON.parse(body) as { queries: { package: { name: string }; version: string }[] };
      return json({ results: queries.map((q) => (q.package.name === 'lodash' && q.version === '4.17.20' ? { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] } : q.package.name === 'ms' ? { vulns: [{ id: NEW_GHSA }] } : {})) });
    }
    if (url.pathname === `/intel/osv/v1/vulns/${NEW_GHSA}`)
      return json({ id: NEW_GHSA, summary: 'ReDoS in ms', aliases: ['CVE-2026-0042'], modified: '2026-10-28T00:00:00Z', affected: [{ package: { ecosystem: 'npm', name: 'ms' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.1.3' }] }] }] });
    return false;
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'argus-intel-e2e-'));
    fixture = createGitRepo(tmp, { 'package.json': JSON.stringify({ name: 'shop' }), 'package-lock.json': lock() });
    const intel = intelRoutes(new Map());
    const ai = aiRoutes(calls, {
      answer: (kind, call) =>
        kind === 'advisory_extraction' && call.text.includes('minimist')
          ? {
              relevant: true,
              advisories: [{ ecosystem: 'npm', packageName: 'minimist', affectedRange: '<1.2.6', fixedVersion: '1.2.6', severity: 'critical', cveIds: ['CVE-2021-44906', 'not-a-cve'], title: 'Prototype pollution in minimist', summary: 'Prototype pollution via constructor.' }],
              rationale: 'The item names minimist and a fixed version.',
              confidence: 0.8,
            }
          : undefined,
    });
    mock = await startMockGitHub({ bare: fixture.bare, token: TOKEN, repos: [{ id: 801, name: 'shop' }], extra: (req, url, body, res) => extra(req, url, body, res) || intel(req, url, body, res) || ai(req, url, body, res) });

    const env = await h.env();
    app = await createApiApp(
      AppConfig.fromEnv({
        ...env,
        ...BASE_TEST_ENV,
        ...intelEnv(mock.baseUrl),
        ARGUS_NVD_URL: `${mock.baseUrl}/nvd`,
        ARGUS_NVD_API_KEY: 'nvd-key',
        ARGUS_ADMIN_PASSWORD: 'Initial-Admin-Pass-1',
        ARGUS_ROLE: 'all',
        ARGUS_SCAN_WORKDIR: join(tmp, 'scans'),
        ARGUS_SCHEDULER_INTERVAL_SECONDS: '1',
        ARGUS_GITLEAKS_PATH: 'argus-test-no-gitleaks',
      }),
    );
    await app.init();
    admin = new Client(app);
    await admin.login('admin', 'Initial-Admin-Pass-1');
    await admin.call('post', '/api/v1/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'Second-Root-Pass-9' });
    const teamId = (await admin.call('post', '/api/v1/teams', { name: 'Shop' })).body.id;
    await admin.call('post', '/api/v1/users', { username: 'dev.intel', displayName: 'Dev Intel', role: 'developer', password: 'Dev-Intel-Pass-1234', teamIds: [teamId] });
    dev = new Client(app);
    await dev.login('dev.intel', 'Dev-Intel-Pass-1234');
    await dev.call('post', '/api/v1/auth/change-password', { currentPassword: 'Dev-Intel-Pass-1234', newPassword: 'Dev-Intel-Pass-5678' });

    const channel = (await admin.call('post', '/api/v1/integrations/channels', { type: 'webhook', name: 'SIEM', enabled: true, config: { url: `${mock.baseUrl}/hook` }, secret: 'whsec_0123456789abcdef' })).body.id;
    await admin.call('post', '/api/v1/integrations/rules', { name: 'Emerging', events: ['emerging_threat'], minSeverity: 'low', channelIds: [channel] });

    await admin.call('post', '/api/v1/sources', { name: 'Mock', provider: 'github', baseUrl: mock.baseUrl, scope: 'acme', token: TOKEN, autoActivatePattern: 'acme/*', defaultTeamId: teamId });
    repo = await waitFor(async () => ((await admin.call('get', '/api/v1/repos')).body as Paged<RepositoryDto>).items[0], { what: 'repository' });
    await waitFor(async () => {
      const r = (await admin.call('get', `/api/v1/repos/${repo.id}`)).body as RepositoryDto;
      return r.lastScanStatus && !['queued', 'running'].includes(r.lastScanStatus);
    }, { what: 'first scan', timeoutMs: 90_000 });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    mock?.server.close();
    await h.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('seeds suggested news sources, switched off, and lets only intel managers change them', async () => {
    const sources = await waitFor(async () => {
      const list = (await admin.call('get', '/api/v1/intel/sources')).body as IntelSourceDto[];
      return list.length ? list : null;
    }, { what: 'seeded sources' });
    expect(sources.length).toBe(4);
    expect(sources.every((s) => !s.enabled)).toBe(true);
    expect((await dev.call('get', '/api/v1/intel/sources')).status).toBe(403);
    expect((await dev.call('get', '/api/v1/intel/overview')).status).toBe(200);
    expect((await admin.call('post', '/api/v1/intel/sources', { name: 'Plain', url: 'http://news.example/feed' })).status).toBe(400);
  });

  it('matches a manual Argus advisory against stored inventories at once, and keeps it through later scans', async () => {
    const bad = await admin.call('post', '/api/v1/intel/advisories', { ecosystem: 'npm', packageName: 'left-pad', affectedRange: 'not a range', fixedVersion: null, severity: 'high', title: 'Bad range' });
    expect(bad.status).toBe(400);
    expect((await dev.call('post', '/api/v1/intel/advisories', { ecosystem: 'npm', packageName: 'left-pad', affectedRange: '<1.3.0', fixedVersion: '1.3.0', severity: 'high', title: 'x' })).status).toBe(403);

    const before = (await overview()).lastRematch?.at ?? null;
    const created = await admin.call('post', '/api/v1/intel/advisories', {
      ecosystem: 'npm',
      packageName: 'left-pad',
      affectedRange: '<1.3.0',
      fixedVersion: '1.3.0',
      severity: 'high',
      cveIds: ['CVE-2091-1234'],
      title: 'Prototype pollution in left-pad',
      summary: 'Found by our red team.',
      references: ['https://example.com/left-pad'],
    });
    expect(created.status).toBe(201);
    const a = created.body as AdvisoryDto;
    expect(a.key).toMatch(/^ARGUS-\d{4}-\d{4}$/);
    expect(a.affectedRepos).toBe(1);

    const run = await rematchAfter(before, 'advisory');
    expect(run).toMatchObject({ trigger: 'advisory', newFindings: 1, error: null });
    const f = (await findings()).find((x) => x.ruleId === a.key)!;
    expect(f).toMatchObject({ status: 'open', package: { name: 'left-pad', fixedVersion: '1.3.0' }, advisory: { id: a.key, aliases: ['CVE-2091-1234'] } });
    const ticket = await waitFor(async () => ((await admin.call('get', '/api/v1/tickets?pageSize=100')).body as Paged<TicketDto>).items.find((t) => t.title.includes('left-pad')), { what: 'ticket' });
    expect(ticket.severity).toBeDefined();

    const o = await overview();
    expect(o.emerging[0]).toMatchObject({ advisoryId: a.key, argusAdvisoryId: a.id, packageName: 'left-pad', repos: 1, findings: 1 });
    await waitFor(async () => hooks.find((x) => x.event === 'emerging_threat' && x.title.includes('left-pad')), { what: 'emerging-threat webhook' });

    // The next scan sees the advisory too, so the finding stays open with the same identity.
    const prev = ((await admin.call('get', `/api/v1/repos/${repo.id}`)).body as RepositoryDto).lastScanRunId;
    await admin.call('post', `/api/v1/repos/${repo.id}/scans`);
    await waitFor(async () => {
      const r = (await admin.call('get', `/api/v1/repos/${repo.id}`)).body as RepositoryDto;
      return r.lastScanRunId !== prev && r.lastScanStatus && !['queued', 'running'].includes(r.lastScanStatus);
    }, { what: 'rescan', timeoutMs: 90_000 });
    expect((await findings()).find((x) => x.ruleId === a.key)).toMatchObject({ id: f.id, status: 'open' });

    // Withdrawn advisories stop matching.
    expect((await admin.call('patch', `/api/v1/intel/advisories/${a.id}`, { withdrawn: true })).body).toMatchObject({ withdrawn: true, affectedRepos: 0 });
    const beforeRestore = (await overview()).lastRematch!.at;
    await admin.call('patch', `/api/v1/intel/advisories/${a.id}`, { withdrawn: false });
    await rematchAfter(beforeRestore, 'advisory');
  });

  it('re-checks inventories against OSV for newly published vulnerabilities, with CVSS from NVD', async () => {
    state.newVuln = true;
    const before = (await overview()).lastRematch?.at ?? null;
    expect((await admin.call('post', '/api/v1/intel/rematch')).status).toBe(202);
    const run = await rematchAfter(before, 'manual');
    expect(run).toMatchObject({ trigger: 'manual', newFindings: 1, repos: 1 });
    const ms = (await findings()).find((x) => x.ruleId === NEW_GHSA)!;
    expect(ms).toMatchObject({ status: 'open', advisory: { cvssScore: 9.8 }, package: { name: 'ms', fixedVersion: '2.1.3' } });
    expect(ms.riskFactors.some((r) => r.label.includes('(NVD)'))).toBe(true);
    expect(state.nvdCalls).toBeGreaterThan(0);

    // Nothing new: a second run opens nothing.
    const again = (await overview()).lastRematch!.at;
    await admin.call('post', '/api/v1/intel/rematch');
    expect(await rematchAfter(again, 'manual')).toMatchObject({ newFindings: 0 });
  });

  it('crawls a news feed, extracts advisories with AI into a review queue, and turns approvals into findings', async () => {
    const src = (await admin.call('post', '/api/v1/intel/sources', { name: 'Mock news', url: `${mock.baseUrl}/feeds/sec.xml`, enabled: true, intervalMinutes: 60 })).body as IntelSourceDto;
    // Without AI the items are collected but not analysed.
    expect(await admin.call('post', `/api/v1/intel/sources/${src.id}/fetch`)).toMatchObject({ status: 200, body: { lastNewItems: 2, lastError: null } });
    let items = ((await admin.call('get', `/api/v1/intel/items?sourceId=${src.id}`)).body as Paged<IntelItemDto>).items;
    expect(items.map((i) => i.status)).toEqual(['new', 'new']);
    const minimist = items.find((i) => i.title.includes('minimist'))!;
    expect(minimist.summary).toContain('minimist before 1.2.6');
    expect(minimist.summary).not.toContain('<script>');
    expect(minimist.summary).not.toContain('alert');
    // Fetching again finds nothing new.
    expect((await admin.call('post', `/api/v1/intel/sources/${src.id}/fetch`)).body.lastNewItems).toBe(0);

    // Turn on AI with advisory extraction, then re-analyse the items.
    const provider = { enabled: true, model: 'claude-opus-5-5', baseUrl: `${mock.baseUrl}/ai/anthropic`, inputPricePerMTok: null, outputPricePerMTok: null };
    const off = { enabled: false, provider: null };
    await admin.call('put', '/api/v1/settings/ai', {
      enabled: true,
      defaultProvider: 'anthropic',
      providers: { anthropic: { ...provider, apiKey: 'sk-ant-intel-0001' }, openai: { ...provider, enabled: false, model: 'gpt-6.1-sol' }, gemini: { ...provider, enabled: false, model: 'gemini-3.8-flash' } },
      useCases: { remediation: off, ticket_draft: off, secret_triage: off, vuln_applicability: off, advisory_extraction: { enabled: true, provider: null } },
      monthlyBudgetUsd: 100,
      maxContextChars: 12000,
      maxScanChecks: 20,
    });
    for (const i of items) expect((await admin.call('post', `/api/v1/intel/items/${i.id}/reanalyse`)).status).toBe(200);
    items = ((await admin.call('get', `/api/v1/intel/items?sourceId=${src.id}`)).body as Paged<IntelItemDto>).items;
    const reviewed = items.find((i) => i.id === minimist.id)!;
    expect(reviewed).toMatchObject({ status: 'review', extraction: { provider: 'anthropic', confidence: 0.8 } });
    expect(reviewed.candidates).toEqual([expect.objectContaining({ packageName: 'minimist', affectedRange: '<1.2.6', cveIds: ['CVE-2021-44906'], references: ['https://news.example/minimist'] })]);
    expect(items.find((i) => i.id !== minimist.id)!.status).toBe('no_match');
    const prompt = calls.find((c) => c.text.includes('minimist'))!.text;
    expect(prompt).toContain('untrusted data');
    expect(prompt).not.toContain('<script>');

    expect((await dev.call('post', `/api/v1/intel/items/${minimist.id}/review`, { action: 'approve', advisories: reviewed.candidates })).status).toBe(403);
    const before = (await overview()).lastRematch?.at ?? null;
    const approved = await admin.call('post', `/api/v1/intel/items/${minimist.id}/review`, { action: 'approve', advisories: reviewed.candidates });
    expect(approved.body).toMatchObject({ status: 'approved', advisoryIds: [expect.any(String)] });
    expect(await rematchAfter(before, 'advisory')).toMatchObject({ newFindings: 1 });
    expect((await findings()).find((x) => x.package?.name === 'minimist')).toMatchObject({ status: 'open', advisory: { aliases: ['CVE-2021-44906'] } });
    expect((await admin.call('post', `/api/v1/intel/items/${minimist.id}/review`, { action: 'reject' })).status).toBe(400);

    const audit = (await admin.call('get', '/api/v1/audit?action=intel.item_approved')).body.items;
    expect(audit[0]).toMatchObject({ actorName: 'admin', targetId: minimist.id });
    const advisories = (await admin.call('get', '/api/v1/intel/advisories?search=minimist')).body as Paged<AdvisoryDto>;
    expect(advisories.items[0]).toMatchObject({ source: 'news', sourceItemId: minimist.id, affectedRepos: 1, autoApproved: false });
  });

  it('refuses feed redirects to plain HTTP', async () => {
    const src = (await admin.call('post', '/api/v1/intel/sources', { name: 'Moved', url: `${mock.baseUrl}/feeds/moved`, enabled: false, intervalMinutes: 60 })).body as IntelSourceDto;
    const res = await admin.call('post', `/api/v1/intel/sources/${src.id}/fetch`);
    expect(res.body.lastError).toMatch(/Refused redirect to http:/);
  });
});
