import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { type Paged, type RepositoryDto, type ScanRunDto, type TicketDetailDto, type TicketDto } from '@argus/shared';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/app.factory';
import { AppConfig } from '../../src/config/app-config';
import { BASE_TEST_ENV, Client, dbHarnesses, waitFor } from './helpers';
import { createGitRepo, type FixtureRepo, type MockGitHub, startMockGitHub } from './mock-github';
import { intelEnv, intelRoutes, lockfile } from './mock-intel';

const TOKEN = 'ghp_e2eTicketsToken012345678';
const SMTP_PASS = 'smtp-pass-0123';
const GRAPH_SECRET = 'graph-secret-0123';
const JIRA_TOKEN = 'jira-token-0123';
const WEBHOOK_SECRET = 'whsec_0123456789abcdef';

interface Captured {
  teams: unknown[];
  webhooks: { headers: Record<string, string | string[] | undefined>; body: string }[];
  graph: { auth: string | undefined; body: Record<string, unknown> }[];
  jiraIssues: { auth: string | undefined; body: Record<string, unknown> }[];
  jiraState: { name: string; cat: string };
  mails: { from: string; to: string[]; raw: string }[];
}

function integrationRoutes(c: Captured) {
  return (req: import('node:http').IncomingMessage, url: URL, body: string, res: import('node:http').ServerResponse) => {
    const json = (data: unknown, status = 200) => (res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)), true);
    const p = url.pathname;
    if (p === '/login/contoso/oauth2/v2.0/token') {
      const form = new URLSearchParams(body);
      return form.get('client_secret') === GRAPH_SECRET ? json({ access_token: 'graph-token', token_type: 'Bearer' }) : json({ error: 'invalid_client' }, 401);
    }
    if (p === '/graph/v1.0/users/argus%40contoso.com/sendMail') {
      c.graph.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      return (res.writeHead(202).end(), true);
    }
    const jiraAuth = `Basic ${Buffer.from(`jira@acme.com:${JIRA_TOKEN}`).toString('base64')}`;
    if (p.startsWith('/jira/')) {
      if (req.headers.authorization !== jiraAuth) return json({ errorMessages: ['Unauthorized'] }, 401);
      if (p === '/jira/rest/api/3/myself') return json({ displayName: 'Argus Bot' });
      if (p === '/jira/rest/api/3/issue' && req.method === 'POST') {
        c.jiraIssues.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        return json({ id: '10001', key: 'SHOP-1' }, 201);
      }
      if (p === '/jira/rest/api/3/issue/SHOP-1') return json({ fields: { status: { name: c.jiraState.name, statusCategory: { key: c.jiraState.cat } } } });
      return json({}, 404);
    }
    if (p === '/teams/hook') {
      c.teams.push(JSON.parse(body));
      return (res.writeHead(202).end(), true);
    }
    if (p === '/hook') {
      c.webhooks.push({ headers: req.headers, body });
      return json({ ok: true });
    }
    return false;
  };
}

const harnesses = dbHarnesses();

describe.each(harnesses)('tickets, email, Jira & notifications e2e: $name', (h) => {
  let app: INestApplication;
  let admin: Client;
  let dev: Client;
  let mock: MockGitHub;
  let smtp: SMTPServer;
  let fixture: FixtureRepo;
  let tmp: string;
  let repo: RepositoryDto;
  let teamId = '';
  const channels: Record<string, string> = {};
  const c: Captured = { teams: [], webhooks: [], graph: [], jiraIssues: [], jiraState: { name: 'To Do', cat: 'new' }, mails: [] };
  const intelCalls = new Map<string, number>();

  const tickets = async (q = 'status=active') => (await admin.call('get', `/api/v1/tickets?${q}&pageSize=100`)).body as Paged<TicketDto>;
  const ticketBy = async (pred: (t: TicketDto) => boolean) => (await tickets('')).items.find(pred)!;
  const detail = async (id: string, client = admin) => (await client.call('get', `/api/v1/tickets/${id}`)).body as TicketDetailDto;
  const latestRun = async (after?: string) =>
    waitFor(
      async () => {
        const r = (await admin.call('get', `/api/v1/repos/${repo.id}`)).body as RepositoryDto;
        if (!r.lastScanRunId || r.lastScanRunId === after || r.lastScanStatus === 'queued' || r.lastScanStatus === 'running') return null;
        return (await admin.call('get', `/api/v1/scans/${r.lastScanRunId}`)).body as ScanRunDto;
      },
      { what: 'scan', timeoutMs: 90_000 },
    );

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'argus-tickets-e2e-'));
    fixture = createGitRepo(tmp, {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { lodash: '^4.17.20', 'gpl-lib': '1.0.0' } }),
      'package-lock.json': lockfile('4.17.20'),
      'src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>',
      'src/config.js': 'module.exports = { accessKeyId: "AKIAIOSFODNN7EXAMPLE" };\n',
    });
    const intel = intelRoutes(intelCalls);
    const integrations = integrationRoutes(c);
    mock = await startMockGitHub({ bare: fixture.bare, token: TOKEN, repos: [{ id: 601, name: 'shop' }], extra: (req, url, body, res) => intel(req, url, body, res) || integrations(req, url, body, res) });

    smtp = new SMTPServer({
      // Built-in self-signed certificate; Argus only accepts it for loopback outside production.
      onAuth: (auth, _session, cb) => (auth.username === 'argus' && auth.password === SMTP_PASS ? cb(null, { user: 'argus' }) : cb(new Error('Invalid credentials'))),
      onData: (stream, session, cb) => {
        let raw = '';
        stream.on('data', (d: Buffer) => (raw += d.toString()));
        stream.on('end', () => {
          c.mails.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw });
          cb();
        });
      },
      logger: false,
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));

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
        ARGUS_GRAPH_URL: `${mock.baseUrl}/graph`,
        ARGUS_ENTRA_LOGIN_URL: `${mock.baseUrl}/login`,
      }),
    );
    await app.init();
    admin = new Client(app);
    await admin.login('admin', 'Initial-Admin-Pass-1');
    await admin.call('post', '/api/v1/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'Second-Root-Pass-9' });
    teamId = (await admin.call('post', '/api/v1/teams', { name: 'Shop' })).body.id;
    await admin.call('post', '/api/v1/users', { username: 'dev.shop', displayName: 'Dev Shop', role: 'developer', password: 'Dev-Shop-Pass-1234', teamIds: [teamId] });
    dev = new Client(app);
    await dev.login('dev.shop', 'Dev-Shop-Pass-1234');
    await dev.call('post', '/api/v1/auth/change-password', { currentPassword: 'Dev-Shop-Pass-1234', newPassword: 'Dev-Shop-Pass-5678' });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    mock?.server.close();
    await new Promise<void>((r) => (smtp ? smtp.close(() => r()) : r()));
    await h.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('configures notification channels with write-only secrets, and a rule', async () => {
    const smtpPort = (smtp.server.address() as AddressInfo).port;
    const defs = {
      smtp: { type: 'email_smtp', name: 'Mail (SMTP)', enabled: true, config: { host: '127.0.0.1', port: smtpPort, security: 'starttls', authMode: 'password', username: 'argus', from: 'argus@acme.com', fromName: 'Argus' }, secret: SMTP_PASS },
      graph: { type: 'email_graph', name: 'Mail (Graph)', enabled: true, config: { tenantId: 'contoso', clientId: 'app-id', sender: 'argus@contoso.com' }, secret: GRAPH_SECRET },
      teams: { type: 'teams_webhook', name: 'Teams', enabled: true, config: {}, secret: `${mock.baseUrl}/teams/hook` },
      hook: { type: 'webhook', name: 'SIEM', enabled: true, config: { url: `${mock.baseUrl}/hook` }, secret: WEBHOOK_SECRET },
    };
    for (const [k, body] of Object.entries(defs)) {
      const res = await admin.call('post', '/api/v1/integrations/channels', body);
      expect(res.status).toBe(201);
      channels[k] = res.body.id;
    }
    const list = await admin.call('get', '/api/v1/integrations/channels');
    const raw = JSON.stringify(list.body);
    for (const secret of [SMTP_PASS, GRAPH_SECRET, WEBHOOK_SECRET, '/teams/hook']) expect(raw).not.toContain(secret);
    expect(list.body.find((x: { id: string }) => x.id === channels.smtp)).toMatchObject({ secretConfigured: true, secretHint: '••••0123' });
    expect((await dev.call('get', '/api/v1/integrations/channels')).status).toBe(403);
    expect((await admin.call('post', '/api/v1/integrations/channels', { ...defs.hook, config: { url: 'http://evil.example/hook' } })).status).toBe(400);

    const test = await admin.call('post', `/api/v1/integrations/channels/${channels.smtp}/test`, { to: 'admin@acme.com' });
    expect(test.body).toMatchObject({ ok: true });
    await waitFor(async () => c.mails.find((m) => m.to.includes('admin@acme.com')), { what: 'test email' });

    const badGraph = await admin.call('put', `/api/v1/integrations/channels/${channels.graph}`, { ...defs.graph, secret: 'wrong-secret' });
    expect(badGraph.status).toBe(200);
    const failed = await admin.call('post', `/api/v1/integrations/channels/${channels.graph}/test`, { to: 'admin@acme.com' });
    expect(failed.body.ok).toBe(false);
    expect(failed.body.message).toMatch(/Microsoft Entra ID returned HTTP 401/);
    expect(failed.body.message).not.toContain('wrong-secret');
    await admin.call('put', `/api/v1/integrations/channels/${channels.graph}`, { ...defs.graph, secret: GRAPH_SECRET });

    const rule = await admin.call('post', '/api/v1/integrations/rules', {
      name: 'Critical issues',
      events: ['ticket_created', 'ticket_reopened'],
      minSeverity: 'critical',
      channelIds: [channels.teams, channels.hook, channels.smtp],
      recipients: ['security@acme.com'],
    });
    expect(rule.status).toBe(201);
  });

  it('opens one ticket per issue after the first scan, with SLA due dates, and notifies on critical ones', async () => {
    await admin.call('post', '/api/v1/sources', { name: 'Mock', provider: 'github', baseUrl: mock.baseUrl, scope: 'acme', token: TOKEN, autoActivatePattern: 'acme/*', defaultTeamId: teamId });
    repo = await waitFor(async () => ((await admin.call('get', '/api/v1/repos')).body as Paged<RepositoryDto>).items[0], { what: 'repository' });
    await latestRun();

    const page = await tickets();
    expect(page.total).toBe(4);
    const vuln = page.items[0];
    expect(vuln).toMatchObject({ scanner: 'dependencies', severity: 'critical', status: 'open', repoFullName: 'acme/shop', openFindings: 1, slaBreached: false });
    expect(vuln.key).toMatch(/^ARG-\d+$/);
    const days = (new Date(vuln.dueAt!).getTime() - new Date(vuln.createdAt).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect(new Set(page.items.map((t) => t.scanner))).toEqual(new Set(['dependencies', 'secrets', 'frameworks', 'licenses']));

    const d = await detail(vuln.id);
    expect(d.events.map((e) => e.type)).toEqual(['created']);
    expect(d.remediation).toMatch(/Upgrade lodash/);
    const finding = (await admin.call('get', `/api/v1/findings?repoId=${repo.id}&search=lodash`)).body.items[0];
    expect(finding.ticketId).toBe(vuln.id);

    // Only the critical ticket matches the rule: one Teams card, one signed webhook, one email.
    await waitFor(async () => c.teams.length >= 1 && c.webhooks.length >= 1 && c.mails.some((m) => m.to.includes('security@acme.com')), { what: 'notifications' });
    expect(JSON.stringify(c.teams[0])).toContain(vuln.key);
    const hook = c.webhooks[0];
    const ts = String(hook.headers['x-argus-timestamp']);
    expect(hook.headers['x-argus-signature']).toBe(`sha256=${createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${hook.body}`).digest('hex')}`);
    expect(JSON.parse(hook.body)).toMatchObject({ event: 'ticket_created', severity: 'critical', url: `http://argus.test/tickets/${vuln.id}` });
    const mail = c.mails.find((m) => m.to.includes('security@acme.com'))!;
    expect(mail.raw).toMatch(new RegExp(`Subject: \\[Argus\\] New: ${vuln.key}`));
    await new Promise((r) => setTimeout(r, 1500));
    expect(c.teams).toHaveLength(1);
  });

  it('lets developers work tickets within their permissions', async () => {
    const t = await ticketBy((x) => x.scanner === 'frameworks');
    expect((await dev.call('post', `/api/v1/tickets/${t.id}/comments`, { body: 'Upgrading to .NET 8 this sprint.' })).status).toBe(201);
    expect((await dev.call('post', `/api/v1/tickets/${t.id}/status`, { status: 'in_progress' })).body.status).toBe('in_progress');
    const assignees = (await dev.call('get', `/api/v1/tickets/${t.id}/assignees`)).body as { id: string; username: string }[];
    const me = assignees.find((a) => a.username === 'dev.shop')!;
    const adminUser = assignees.find((a) => a.username === 'admin')!;
    expect((await dev.call('patch', `/api/v1/tickets/${t.id}`, { assigneeId: adminUser.id })).status).toBe(403);
    expect((await dev.call('patch', `/api/v1/tickets/${t.id}`, { assigneeId: me.id, labels: ['dotnet', 'q4'] })).body).toMatchObject({ assigneeName: 'Dev Shop', labels: ['dotnet', 'q4'] });
    expect((await dev.call('post', `/api/v1/tickets/${t.id}/status`, { status: 'risk_accepted', reason: 'Not now please' })).status).toBe(403);
    expect((await dev.call('post', `/api/v1/tickets/${t.id}/status`, { status: 'closed' })).status).toBe(403);

    const d = await detail(t.id, dev);
    expect(d.events.map((e) => e.type)).toEqual(['created', 'comment', 'status', 'assignment', 'labels']);
    expect(d.watcherIds).toContain(me.id);
    expect((await dev.call('get', '/api/v1/tickets?assignee=me')).body.total).toBe(1);
    expect((await dev.call('get', '/api/v1/tickets/summary')).body).toMatchObject({ active: 4, assignedToMe: 1 });
  });

  it('emails a ticket through Microsoft Graph from the ticket itself', async () => {
    const t = await ticketBy((x) => x.scanner === 'secrets');
    expect((await dev.call('get', '/api/v1/tickets/email-channels')).body.map((x: { name: string }) => x.name).sort()).toEqual(['Mail (Graph)', 'Mail (SMTP)']);
    const res = await dev.call('post', `/api/v1/tickets/${t.id}/email`, { channelId: channels.graph, to: ['owner@acme.com'], cc: ['lead@acme.com'], message: 'Please rotate this key today.' });
    expect(res.body).toEqual({ sent: true });
    const sent = c.graph.at(-1)!;
    expect(sent.auth).toBe('Bearer graph-token');
    const msg = sent.body.message as { subject: string; body: { content: string }; toRecipients: unknown[]; ccRecipients: unknown[] };
    expect(msg.subject).toBe(`[Argus] ${t.key} ${t.title}`);
    expect(msg.body.content).toContain('Please rotate this key today.');
    expect(msg.toRecipients).toEqual([{ emailAddress: { address: 'owner@acme.com' } }]);
    expect(msg.ccRecipients).toEqual([{ emailAddress: { address: 'lead@acme.com' } }]);
    expect((await detail(t.id)).events.at(-1)).toMatchObject({ type: 'email_sent', body: 'Please rotate this key today.', data: { channel: 'Mail (Graph)', to: ['owner@acme.com'] } });
  });

  it('creates a Jira issue in the repository project and follows its status', async () => {
    const t = await ticketBy((x) => x.scanner === 'dependencies');
    expect((await admin.call('post', `/api/v1/tickets/${t.id}/jira`, {})).status).toBe(400);
    const jira = await admin.call('put', '/api/v1/integrations/jira', { enabled: true, deployment: 'cloud', baseUrl: `${mock.baseUrl}/jira`, email: 'jira@acme.com', token: JIRA_TOKEN, defaultIssueType: 'Bug', label: 'security' });
    expect(jira.body).toMatchObject({ tokenConfigured: true, tokenHint: '••••0123' });
    expect(JSON.stringify(jira.body)).not.toContain(JIRA_TOKEN);
    expect((await admin.call('post', '/api/v1/integrations/jira/test')).body).toEqual({ ok: true, message: 'Connected as Argus Bot.' });
    expect((await admin.call('post', `/api/v1/tickets/${t.id}/jira`, {})).body.message).toMatch(/Choose a Jira project/);

    await admin.call('patch', `/api/v1/repos/${repo.id}`, { jiraProjectKey: 'SHOP' });
    const created = await dev.call('post', `/api/v1/tickets/${t.id}/jira`, {});
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ key: 'SHOP-1', url: `${mock.baseUrl}/jira/browse/SHOP-1` });
    const fields = c.jiraIssues[0].body.fields as { project: { key: string }; summary: string; issuetype: { name: string }; labels: string[]; description: { type: string } };
    expect(fields).toMatchObject({ project: { key: 'SHOP' }, issuetype: { name: 'Bug' }, labels: ['argus', 'security'] });
    expect(fields.summary).toBe(`[${t.key}] ${t.title}`);
    expect(fields.description.type).toBe('doc');
    expect((await dev.call('post', `/api/v1/tickets/${t.id}/jira`, {})).status).toBe(409);

    c.jiraState = { name: 'Done', cat: 'done' };
    const synced = (await dev.call('post', `/api/v1/tickets/${t.id}/jira/sync`)).body as TicketDetailDto;
    expect(synced.status).toBe('resolved');
    expect(synced.jira).toMatchObject({ key: 'SHOP-1', status: 'Done', statusCategory: 'done' });
    expect(synced.events.map((e) => e.type).slice(-2)).toEqual(['jira_status', 'status']);
  });

  it('risk acceptance creates a ticket-scoped suppression; reopening removes it', async () => {
    const t = await ticketBy((x) => x.scanner === 'licenses');
    expect((await admin.call('post', `/api/v1/tickets/${t.id}/status`, { status: 'risk_accepted' })).status).toBe(400);
    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const accepted = await admin.call('post', `/api/v1/tickets/${t.id}/status`, { status: 'risk_accepted', reason: 'Internal tool, legal approved', expiresAt: expires });
    expect(accepted.body).toMatchObject({ status: 'risk_accepted', openFindings: 0 });
    const suppression = ((await admin.call('get', '/api/v1/suppressions')).body as { id: string; ticketId: string; reason: string }[]).find((s) => s.ticketId === t.id)!;
    expect(suppression.reason).toMatch(/Risk accepted on ARG-\d+: Internal tool, legal approved/);
    expect((await admin.call('get', `/api/v1/findings?repoId=${repo.id}&scanner=licenses`)).body.items[0].status).toBe('suppressed');

    const reopened = await admin.call('post', `/api/v1/tickets/${t.id}/status`, { status: 'open', reason: 'Legal withdrew approval' });
    expect(reopened.body).toMatchObject({ status: 'open', suppressionId: null, openFindings: 1 });
    expect(((await admin.call('get', '/api/v1/suppressions')).body as { ticketId: string }[]).some((s) => s.ticketId === t.id)).toBe(false);
    // No automatic "reopened"/"accepted" noise from the suppression changes themselves.
    expect((await detail(t.id)).events.map((e) => e.type)).toEqual(['created', 'status', 'status']);
  });

  it('resolves tickets automatically when a scan no longer finds the issue', async () => {
    const before = (await admin.call('get', `/api/v1/repos/${repo.id}`)).body as RepositoryDto;
    fixture.commit({ 'src/config.js': 'module.exports = { region: process.env.AWS_REGION };\n', 'package-lock.json': lockfile('4.17.21') }, 'Remove key, upgrade lodash');
    await admin.call('post', `/api/v1/repos/${repo.id}/scans`);
    await latestRun(before.lastScanRunId!);

    const secret = await ticketBy((x) => x.scanner === 'secrets');
    expect(secret).toMatchObject({ status: 'resolved', openFindings: 0 });
    expect((await detail(secret.id)).events.at(-1)).toMatchObject({ type: 'auto_resolved', actorName: 'Argus' });
    // Resolved via Jira earlier; the scan now confirms it and it stays resolved.
    expect((await ticketBy((x) => x.scanner === 'dependencies')).status).toBe('resolved');
    expect((await ticketBy((x) => x.scanner === 'frameworks')).status).toBe('in_progress');
    expect((await tickets()).total).toBe(2);
  });

  it('bulk-updates, exports, scopes by team and audits', async () => {
    const active = (await tickets()).items.map((t) => t.id);
    expect((await admin.call('post', '/api/v1/tickets/bulk', { ids: active, status: 'triaged' })).body).toEqual({ updated: 2 });
    const csv = await admin.call('get', '/api/v1/tickets/export?status=active');
    expect(csv.text.split('\r\n')[0]).toBe('key,title,severity,risk_score,status,repository,assignee,due,sla_breached,open_findings,jira,created,resolved');
    expect(csv.text.split('\r\n')).toHaveLength(3);

    await admin.call('post', '/api/v1/users', { username: 'outsider', displayName: 'Outsider', role: 'developer', password: 'Visitor-Pass-12345' });
    const o = new Client(app);
    await o.login('outsider', 'Visitor-Pass-12345');
    await o.call('post', '/api/v1/auth/change-password', { currentPassword: 'Visitor-Pass-12345', newPassword: 'Visitor-Pass-67890' });
    expect((await o.call('get', '/api/v1/tickets')).body.total).toBe(0);
    expect((await o.call('get', `/api/v1/tickets/${active[0]}`)).status).toBe(404);

    const actions = new Set(((await admin.call('get', '/api/v1/audit?pageSize=100')).body.items as { action: string }[]).map((e) => e.action));
    for (const a of ['channel.created', 'channel.tested', 'notification_rule.created', 'integration.jira_updated', 'ticket.jira_created', 'ticket.email_sent', 'ticket.status_changed', 'ticket.updated', 'tickets.exported']) {
      expect(actions).toContain(a);
    }
    expect(intelCalls.get('osv-query')).toBeGreaterThan(0);
  });
});
