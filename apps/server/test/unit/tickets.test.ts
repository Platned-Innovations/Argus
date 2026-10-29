import { createHmac } from 'node:crypto';
import { type Finding } from '@argus/data';
import { DEFAULT_TICKETING_SETTINGS } from '@argus/shared';
import { describe, expect, it } from 'vitest';
import { emailSubject, escapeHtml, type Message, renderEmail, renderSlack, renderTeams, signWebhook } from '../../src/integrations/messages';
import { isoWeek } from '../../src/integrations/notifications.service';
import { groupKeyFor } from '../../src/scanning/group-key';
import { decideStatus, leadFinding, severityRank, slaDueAt, ticketTitle } from '../../src/tickets/ticket-rules';

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: crypto.randomUUID(),
  repoId: 'r',
  sourceId: 's',
  teamId: null,
  scanner: 'dependencies',
  ruleId: 'GHSA-1',
  fingerprint: crypto.randomUUID(),
  title: 'lodash@4.17.20: Command injection',
  description: null,
  severity: 'high',
  riskScore: 75,
  riskFactors: [],
  status: 'open',
  path: 'package-lock.json',
  line: null,
  package: { ecosystem: 'npm', name: 'lodash', version: '4.17.20', direct: true, dev: false, fixedVersion: '4.17.21' },
  advisory: null,
  secret: null,
  details: null,
  remediation: null,
  suppressionId: null,
  ticketId: null,
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
  firstRunId: 'x',
  lastRunId: 'x',
  fixedAt: null,
  ...over,
});

describe('ticket grouping', () => {
  it('groups one advisory for one package across manifests, and one secret across files', () => {
    const a = finding({ path: 'package-lock.json' });
    const b = finding({ path: 'web/package-lock.json' });
    expect(groupKeyFor(a)).toBe(groupKeyFor(b));
    expect(groupKeyFor(a)).not.toBe(groupKeyFor(finding({ ruleId: 'GHSA-2' })));
    const s1 = finding({ scanner: 'secrets', ruleId: 'aws', package: null, secret: { type: 'aws', preview: 'AKIA…', hash: 'h1' }, path: 'a.js' });
    const s2 = finding({ scanner: 'secrets', ruleId: 'aws', package: null, secret: { type: 'aws', preview: 'AKIA…', hash: 'h1' }, path: 'b.js' });
    expect(groupKeyFor(s1)).toBe(groupKeyFor(s2));
    // NuGet ids are case-insensitive.
    const n1 = finding({ package: { ecosystem: 'nuget', name: 'Newtonsoft.Json', version: '1', direct: true, dev: false, fixedVersion: null } });
    const n2 = finding({ package: { ecosystem: 'nuget', name: 'newtonsoft.json', version: '2', direct: true, dev: false, fixedVersion: null } });
    expect(groupKeyFor(n1)).toBe(groupKeyFor(n2));
    const fw = finding({ scanner: 'frameworks', ruleId: 'framework-eol', package: null, details: { product: 'dotnet', cycle: '6' } });
    expect(groupKeyFor(fw)).toBe('frameworks|dotnet|6');
  });

  it('titles a group by its riskiest open finding and counts extra locations', () => {
    const group = [finding({ riskScore: 50, title: 'lower' }), finding({ riskScore: 90, title: 'riskiest', path: 'a/package-lock.json' }), finding({ riskScore: 99, status: 'fixed', title: 'fixed' })];
    expect(leadFinding(group).title).toBe('riskiest');
    expect(ticketTitle(group)).toBe('riskiest (+1 more location)');
  });
});

describe('ticket lifecycle', () => {
  const counts = (open: number, suppressed = 0, total = open + suppressed) => ({ open, suppressed, total });

  it('resolves when every finding is fixed and accepts when the rest are suppressed', () => {
    expect(decideStatus('open', counts(0, 0, 2), true)).toEqual({ status: 'resolved', change: 'auto_resolved' });
    expect(decideStatus('in_progress', counts(0, 1, 2), false)).toEqual({ status: 'risk_accepted', change: 'auto_accepted' });
    expect(decideStatus('open', counts(1), true)).toEqual({ status: 'open', change: null });
  });

  it('reopens accepted tickets whenever findings reappear, but resolved ones only after a scan', () => {
    expect(decideStatus('risk_accepted', counts(1), false)).toEqual({ status: 'reopened', change: 'reopened' });
    expect(decideStatus('false_positive', counts(1), true).change).toBe('reopened');
    expect(decideStatus('resolved', counts(1), false)).toEqual({ status: 'resolved', change: null });
    expect(decideStatus('resolved', counts(1), true)).toEqual({ status: 'reopened', change: 'reopened' });
    expect(decideStatus('closed', counts(1), true).change).toBe('reopened');
    expect(decideStatus('closed', counts(0, 0, 1), true).change).toBeNull();
  });

  it('computes SLA due dates by severity', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(slaDueAt(from, 'critical', DEFAULT_TICKETING_SETTINGS).toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(slaDueAt(from, 'high', DEFAULT_TICKETING_SETTINGS).toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(severityRank('critical')).toBeGreaterThan(severityRank('low'));
  });
});

describe('messages', () => {
  const m: Message = {
    event: 'ticket_created',
    title: 'ARG-1 <script>alert(1)</script>',
    summary: 'Line one\nLine <two> & "three"',
    severity: 'high',
    url: 'https://argus.example.com/tickets/1?a=1&b=2',
    facts: [{ name: 'Repository', value: 'acme/<x>' }],
    note: 'Please look <b>now</b>',
  };

  it('escapes everything in HTML email and keeps subjects single-line', () => {
    const e = renderEmail(m);
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(e.html).toContain('acme/&lt;x&gt;');
    expect(e.html).toContain('Please look &lt;b&gt;now&lt;/b&gt;');
    expect(e.html).toContain('href="https://argus.example.com/tickets/1?a=1&amp;b=2"');
    expect(e.html).toContain('Line &lt;two&gt; &amp; &quot;three&quot;');
    expect(e.html).toContain('Line one<br>Line');
    expect(e.text).toContain('Open ticket: https://argus.example.com/tickets/1?a=1&b=2');
    expect(emailSubject('a\r\nBcc: victim@example.com')).toBe('a Bcc: victim@example.com');
    expect(escapeHtml(`'"`)).toBe('&#39;&quot;');
  });

  it('uses the configured product name, escaped', () => {
    const e = renderEmail({ ...m, event: 'test' }, 'Contoso & Co');
    expect(e.subject).toBe('[Contoso & Co] ARG-1 <script>alert(1)</script>');
    expect(e.text).toContain('Open in Contoso & Co: https://');
    expect(e.html).toContain('Sent by Contoso &amp; Co security monitoring.');
    expect(e.html).toContain('>Open in Contoso &amp; Co</a>');
  });

  it('labels each kind of email, its button and why it was sent, in HTML and plain text', () => {
    const alert = renderEmail(m);
    expect(alert.html).toContain('>New ticket<');
    expect(alert.html).toMatch(/>high<\/span>/);
    expect(alert.html).toContain('>Open ticket</a>');
    expect(alert.text.split('\n')[0]).toBe('Argus · New ticket · HIGH');
    expect(alert.text).toContain('a notification rule in Argus sends new tickets to this address');
    expect(alert.text).toContain('Message:\nPlease look <b>now</b>');

    const invite = renderEmail({ event: 'invite', title: 'You are invited to Argus', summary: 'Join us.', severity: null, url: 'https://argus.example.com/invite#t', facts: [] });
    expect(invite.html).toContain('>Create your account</a>');
    expect(invite.html).not.toContain('text-transform:uppercase">info');
    expect(invite.text).toContain('If you were not expecting it, you can ignore this email.');

    const report = renderEmail({ event: 'monthly_report', title: 'October', summary: 'Posture', severity: null, url: null, facts: [], attachments: [{ filename: 'r<1>.pdf', contentType: 'application/pdf', content: Buffer.from('x') }] });
    expect(report.html).toContain('Attached: <strong>r&lt;1&gt;.pdf</strong>');
    expect(report.html).not.toContain('<a href');
    expect(report.text).toContain('Attached: r<1>.pdf');

    expect(renderEmail({ ...m, event: 'something_new' }).html).toContain('>Notification<');
  });

  it('renders Teams adaptive cards and Slack blocks without markup injection', () => {
    const teams = renderTeams(m) as { attachments: { contentType: string; content: { actions: { url: string }[] } }[] };
    expect(teams.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(teams.attachments[0].content.actions[0].url).toBe(m.url);
    const slack = JSON.stringify(renderSlack(m));
    expect(slack).toContain('Line &lt;two&gt; &amp;');
    expect(slack).not.toContain('<two>');
  });

  it('signs webhooks over timestamp and body', () => {
    const sig = signWebhook('secret', '{"a":1}', 1700000000);
    expect(sig).toBe(`sha256=${createHmac('sha256', 'secret').update('1700000000.{"a":1}').digest('hex')}`);
  });

  it('computes ISO weeks for the weekly digest', () => {
    expect(isoWeek(new Date('2026-10-26T07:00:00Z'))).toBe('2026-W44');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  });
});
