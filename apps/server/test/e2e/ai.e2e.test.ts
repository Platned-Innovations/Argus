import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { type AiSettingsDto, type Paged, type RepositoryDto, type TicketDetailDto, type TicketDto } from '@argus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { AppConfig } from '../../src/config/app-config';
import { BASE_TEST_ENV, Client, dbHarnesses, waitFor } from './helpers';
import { type AiCall, aiRoutes } from './mock-ai';
import { createGitRepo, type FixtureRepo, type MockGitHub, startMockGitHub } from './mock-github';
import { intelEnv, intelRoutes, lockfile } from './mock-intel';

const TOKEN = 'ghp_e2eAiToken0123456789abcd';
const KEYS = { anthropic: 'sk-ant-e2e-key-0001', openai: 'sk-openai-e2e-key-0002', gemini: 'gemini-e2e-key-0003' };
/** A realistic-looking leaked key in application code, and a documented example key in a test fixture. */
// Assembled at runtime so the fake credential never appears as a literal that secret scanners flag.
const REAL_KEY = ['AKIA', 'Z7Q2XVBN4KDF3HJW'].join('');
const EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';

const harnesses = dbHarnesses();

describe.each(harnesses)('AI assistance e2e: $name', (h) => {
  let app: INestApplication;
  let admin: Client;
  let dev: Client;
  let mock: MockGitHub;
  let fixture: FixtureRepo;
  let tmp: string;
  let repo: RepositoryDto;
  let vuln: TicketDto;
  const calls: AiCall[] = [];
  const mode: { answer: 'default' | 'invalid' } = { answer: 'default' };

  const settingsBody = (over: Record<string, unknown> = {}) => {
    const provider = (name: keyof typeof KEYS, extra: Record<string, unknown> = {}) => ({
      enabled: true,
      model: { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', gemini: 'gemini-3.8-flash' }[name],
      baseUrl: `${mock.baseUrl}/ai/${name}`,
      inputPricePerMTok: null,
      outputPricePerMTok: null,
      ...extra,
    });
    return {
      enabled: true,
      defaultProvider: 'anthropic',
      providers: { anthropic: provider('anthropic'), openai: provider('openai'), gemini: provider('gemini') },
      useCases: {
        remediation: { enabled: true, provider: null },
        ticket_draft: { enabled: true, provider: 'openai' },
        secret_triage: { enabled: true, provider: null },
        vuln_applicability: { enabled: true, provider: 'gemini' },
      },
      monthlyBudgetUsd: 100,
      maxContextChars: 12000,
      maxScanChecks: 20,
      ...over,
    };
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'argus-ai-e2e-'));
    fixture = createGitRepo(tmp, {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { lodash: '^4.17.20', 'gpl-lib': '1.0.0' } }),
      'package-lock.json': lockfile('4.17.20'),
      'src/render.js': "const _ = require('lodash');\nmodule.exports = (input) => _.template(input)();\n",
      'src/config.js': `module.exports = { region: 'eu-west-1', accessKeyId: "${REAL_KEY}" };\n`,
      'test/fixtures/aws.js': `// Example credentials from the AWS documentation\nexports.key = "${EXAMPLE_KEY}";\n`,
    });
    const intel = intelRoutes(new Map());
    const ai = aiRoutes(calls, { answer: () => (mode.answer === 'invalid' ? '{"summary": 42}' : undefined) });
    mock = await startMockGitHub({ bare: fixture.bare, token: TOKEN, repos: [{ id: 701, name: 'shop' }], extra: (req, url, body, res) => intel(req, url, body, res) || ai(req, url, body, res) });

    const env = await h.env();
    app = await createApiApp(
      AppConfig.fromEnv({
        ...env,
        ...BASE_TEST_ENV,
        ...intelEnv(mock.baseUrl),
        ARGUS_ADMIN_PASSWORD: 'Initial-Admin-Pass-1',
        ARGUS_ROLE: 'all',
        ARGUS_PUBLIC_URL: 'http://argus.test',
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
    await admin.call('post', '/api/v1/users', { username: 'dev.ai', displayName: 'Dev AI', role: 'developer', password: 'Dev-Ai-Pass-12345', teamIds: [teamId] });
    dev = new Client(app);
    await dev.login('dev.ai', 'Dev-Ai-Pass-12345');
    await dev.call('post', '/api/v1/auth/change-password', { currentPassword: 'Dev-Ai-Pass-12345', newPassword: 'Dev-Ai-Pass-67890' });

    await admin.call('post', '/api/v1/sources', { name: 'Mock', provider: 'github', baseUrl: mock.baseUrl, scope: 'acme', token: TOKEN, autoActivatePattern: 'acme/*', defaultTeamId: teamId });
    repo = await waitFor(async () => ((await admin.call('get', '/api/v1/repos')).body as Paged<RepositoryDto>).items[0], { what: 'repository' });
    await waitFor(async () => {
      const r = (await admin.call('get', `/api/v1/repos/${repo.id}`)).body as RepositoryDto;
      return r.lastScanStatus && !['queued', 'running'].includes(r.lastScanStatus);
    }, { what: 'first scan', timeoutMs: 90_000 });
    vuln = ((await admin.call('get', '/api/v1/tickets?scanner=dependencies&pageSize=100')).body as Paged<TicketDto>).items.find((t) => t.title.includes('lodash'))!;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    mock?.server.close();
    await h.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('starts switched off and refuses AI requests', async () => {
    const s = (await admin.call('get', '/api/v1/settings/ai')).body as AiSettingsDto;
    expect(s).toMatchObject({ enabled: false, defaultProvider: 'anthropic', providers: { anthropic: { enabled: false, keyConfigured: false, model: 'claude-opus-5-5' } } });
    expect((await dev.call('get', '/api/v1/ai/status')).body).toMatchObject({ enabled: false, useCases: { remediation: false } });
    const res = await dev.call('post', `/api/v1/tickets/${vuln.id}/ai/remediation`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/turned off/);
    expect(calls).toHaveLength(0);
  });

  it('stores provider keys encrypted and write-only; only administrators manage settings', async () => {
    expect((await dev.call('get', '/api/v1/settings/ai')).status).toBe(403);
    const noKey = await admin.call('put', '/api/v1/settings/ai', settingsBody());
    expect(noKey.status).toBe(400);
    expect(noKey.body.message).toMatch(/API key/);

    const body = settingsBody();
    for (const [p, key] of Object.entries(KEYS)) Object.assign((body.providers as Record<string, object>)[p], { apiKey: key });
    const saved = await admin.call('put', '/api/v1/settings/ai', body);
    expect(saved.status).toBe(200);
    const raw = JSON.stringify(saved.body) + JSON.stringify((await admin.call('get', '/api/v1/settings/ai')).body);
    for (const key of Object.values(KEYS)) expect(raw).not.toContain(key);
    expect(saved.body.providers.openai).toMatchObject({ keyConfigured: true, keyHint: '••••0002' });

    // Saving again without keys keeps them.
    expect((await admin.call('put', '/api/v1/settings/ai', settingsBody())).body.providers.gemini.keyConfigured).toBe(true);
    const audit = (await admin.call('get', '/api/v1/audit?action=settings.ai_updated')).body.items;
    // Newest first: the second save changed no keys, the first set all three.
    expect(audit.map((a: { details: { keysChanged: string[] } }) => a.details.keysChanged)).toEqual([[], ['anthropic', 'openai', 'gemini']]);
    expect(JSON.stringify(audit)).not.toContain(KEYS.anthropic);

    for (const provider of ['anthropic', 'openai', 'gemini']) {
      const t = await admin.call('post', '/api/v1/settings/ai/test', { provider });
      expect(t.body).toMatchObject({ ok: true });
    }
    expect(calls.find((c) => c.provider === 'anthropic')!.headers.authorization).toBe(`Bearer ${KEYS.anthropic}`);
    expect(calls.find((c) => c.provider === 'gemini')!.headers['x-goog-api-key']).toBe(KEYS.gemini);
    expect((await dev.call('get', '/api/v1/ai/status')).body).toMatchObject({ enabled: true, useCases: { remediation: true, ticket_draft: true }, budgetExhausted: false });
  });

  it('suggests a remediation for a ticket, labelled and audited, without touching the ticket status', async () => {
    calls.length = 0;
    const res = await dev.call('post', `/api/v1/tickets/${vuln.id}/ai/remediation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ useCase: 'remediation', provider: 'anthropic', model: 'claude-opus-5-5', createdByName: 'Dev AI', output: { fixVersion: '4.17.21', breakingChangeRisk: 'low' } });

    expect(calls).toHaveLength(1);
    const prompt = calls[0].text;
    expect(prompt).toContain('lodash@4.17.20');
    expect(prompt).toContain('GHSA-35jh-r3h4-6jhm');
    expect(prompt).toContain('untrusted data');
    for (const secret of [REAL_KEY, EXAMPLE_KEY, TOKEN, ...Object.values(KEYS)]) expect(prompt).not.toContain(secret);

    expect((await dev.call('get', `/api/v1/tickets/${vuln.id}/ai/remediation`)).body.id).toBe(res.body.id);
    const d = (await dev.call('get', `/api/v1/tickets/${vuln.id}`)).body as TicketDetailDto;
    expect(d.status).toBe('open');
    expect(d.events.map((e) => e.type)).toContain('ai_suggestion');

    const comment = await dev.call('post', `/api/v1/tickets/${vuln.id}/ai/remediation/comment`);
    expect(comment.status).toBe(201);
    expect(comment.body.body).toMatch(/^AI-assisted suggestion/);
    expect(comment.body.data).toMatchObject({ aiAssisted: true, provider: 'anthropic' });

    const audit = (await admin.call('get', '/api/v1/audit?action=ai.request')).body.items;
    expect(audit[0]).toMatchObject({ actorName: 'dev.ai', outcome: 'success', targetType: 'ticket', targetId: vuln.id, details: { useCase: 'remediation', provider: 'anthropic', inputTokens: 1000, outputTokens: 200 } });
    expect(JSON.stringify(audit)).not.toContain('lodash@4.17.20');
  });

  it('drafts Jira and email text with the provider chosen for the use case', async () => {
    calls.length = 0;
    const jira = await dev.call('post', `/api/v1/tickets/${vuln.id}/ai/draft`, { target: 'jira' });
    expect(jira.status).toBe(200);
    expect(jira.body).toMatchObject({ subject: expect.stringContaining('lodash'), provider: 'openai', model: 'gpt-6.1-sol' });
    expect(calls[0].provider).toBe('openai');
    expect(calls[0].text).toContain('Draft a Jira issue');
    expect((await dev.call('post', `/api/v1/tickets/${vuln.id}/ai/draft`, { target: 'sms' })).status).toBe(400);
  });

  it('discards answers that do not match the schema, and accounts usage and cost', async () => {
    mode.answer = 'invalid';
    try {
      const res = await dev.call('post', `/api/v1/tickets/${vuln.id}/ai/remediation`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('AI_OUTPUT');
    } finally {
      mode.answer = 'default';
    }
    // The earlier valid suggestion is kept.
    expect((await dev.call('get', `/api/v1/tickets/${vuln.id}/ai/remediation`)).body.output.fixVersion).toBe('4.17.21');

    const usage = (await admin.call('get', '/api/v1/settings/ai/usage')).body;
    const row = usage.rows.find((r: { provider: string; useCase: string }) => r.provider === 'anthropic' && r.useCase === 'remediation');
    // claude-opus-5-5 list price: $4 / $20 per million tokens; each mock answer uses 1000 in + 200 out.
    expect(row).toMatchObject({ requests: 2, failures: 1, inputTokens: 2000, outputTokens: 400 });
    expect(row.costUsd).toBeCloseTo(0.016, 6);
    expect(usage.budgetUsd).toBe(100);
    expect((await dev.call('get', '/api/v1/settings/ai/usage')).status).toBe(403);
  });

  it('honours the per-repository opt-out and the monthly budget', async () => {
    await admin.call('patch', `/api/v1/repos/${repo.id}`, { aiEnabled: false });
    const excluded = await dev.call('post', `/api/v1/tickets/${vuln.id}/ai/remediation`);
    expect(excluded.status).toBe(400);
    expect(excluded.body.message).toMatch(/excluded from AI/);
    await admin.call('patch', `/api/v1/repos/${repo.id}`, { aiEnabled: true });

    await admin.call('put', '/api/v1/settings/ai', settingsBody({ monthlyBudgetUsd: 0.01 }));
    expect((await dev.call('get', '/api/v1/ai/status')).body.budgetExhausted).toBe(true);
    const over = await dev.call('post', `/api/v1/tickets/${vuln.id}/ai/draft`, { target: 'email' });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/budget/);
    await admin.call('put', '/api/v1/settings/ai', settingsBody());
  });
});
