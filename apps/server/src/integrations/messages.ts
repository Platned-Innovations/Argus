import { createHmac } from 'node:crypto';
import { type Severity } from '@argus/shared';

/** A channel-neutral notification. Every renderer escapes or encodes values for its own format. */
export interface Message {
  event: string;
  title: string;
  summary: string;
  severity: Severity | null;
  url: string | null;
  facts: { name: string; value: string }[];
  /** Free text from a person (e.g. the note added when emailing a ticket). */
  note?: string | null;
  /** Files for email channels (e.g. the monthly report PDF); other channels ignore them. */
  attachments?: Attachment[];
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SEVERITY_COLOR: Record<Severity, string> = { critical: '#dc2626', high: '#f97316', medium: '#d97706', low: '#0284c7', info: '#64748b' };

/** Header-safe subject: no line breaks (prevents header injection), bounded length. */
export function emailSubject(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/** How each kind of email introduces itself, labels its button, and explains why it was sent. */
interface EmailKind {
  label: string;
  action: string;
  why: (product: string) => string;
}

const ruleReason = (what: string) => (product: string) => `You receive this because a notification rule in ${product} sends ${what} to this address.`;

const EMAIL_KINDS: Record<string, EmailKind> = {
  ticket_created: { label: 'New ticket', action: 'Open ticket', why: ruleReason('new tickets') },
  ticket_reopened: { label: 'Ticket reopened', action: 'Open ticket', why: ruleReason('reopened tickets') },
  sla_breached: { label: 'SLA breached', action: 'Open ticket', why: ruleReason('SLA breaches') },
  ticket_email: { label: 'Shared ticket', action: 'Open ticket', why: (p) => `Someone shared this ticket with you from ${p}.` },
  scan_failed: { label: 'Scan failed', action: 'Open repository', why: ruleReason('failed scans') },
  weekly_digest: { label: 'Weekly digest', action: 'Open dashboard', why: ruleReason('the weekly digest') },
  monthly_report: { label: 'Monthly report', action: 'Open dashboard', why: ruleReason('the monthly security report') },
  emerging_threat: { label: 'Emerging threat', action: 'Open advisory', why: ruleReason('emerging threats') },
  credential_expiring: { label: 'Credential expiring', action: 'Open credentials', why: ruleReason('credential expiry notices') },
  invite: { label: 'Invitation', action: 'Create your account', why: (p) => `You received this because an administrator invited you to ${p}. If you were not expecting it, you can ignore this email.` },
  sign_in_link: { label: 'Sign-in link', action: 'Sign in', why: (p) => `Someone asked to sign in to ${p} with this email address. If it was not you, ignore this email: the link only works for whoever opens it from this inbox, and your password has not changed.` },
  test: { label: 'Test message', action: 'Open', why: (p) => `This test was sent from the integration settings in ${p}.` },
};

const SEVERITY_TINT: Record<Severity, string> = { critical: '#fef2f2', high: '#fff7ed', medium: '#fffbeb', low: '#f0f9ff', info: '#f8fafc' };
const BRAND = '#4f46e5';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function kindOf(m: Message): EmailKind {
  return EMAIL_KINDS[m.event] ?? { label: 'Notification', action: 'Open', why: (p) => `Sent by ${p} security monitoring.` };
}

/** Escapes text and keeps its line breaks (white-space:pre-line is not supported by every client). */
const block = (s: string) => escapeHtml(s).replace(/\r?\n/g, '<br>');

/**
 * One template for every email (alerts, digests, reports, shared tickets, invitations, tests). Table layout and inline
 * styles only, because email clients drop <style> blocks and most CSS. Every value is escaped. `product` is the
 * installation's product name (branding).
 */
export function renderEmail(m: Message, product = 'Argus'): EmailContent {
  const kind = kindOf(m);
  const action = kind.action === 'Open' ? `Open in ${product}` : kind.action;
  const why = kind.why(product);
  const sev = m.severity;
  const accent = sev ? SEVERITY_COLOR[sev] : BRAND;
  const files = m.attachments ?? [];

  const text = [
    `${product} · ${kind.label}${sev ? ` · ${sev.toUpperCase()}` : ''}`,
    '',
    m.title,
    '='.repeat(Math.min(m.title.length, 72)),
    '',
    m.summary,
    ...(m.note ? ['', 'Message:', m.note] : []),
    ...(m.facts.length ? ['', ...m.facts.map((f) => `${f.name}: ${f.value}`)] : []),
    ...(files.length ? ['', `Attached: ${files.map((f) => f.filename).join(', ')}`] : []),
    ...(m.url ? ['', `${action}: ${m.url}`] : []),
    '',
    '--',
    why,
  ].join('\n');

  const p = 'margin:0;';
  const badge = sev
    ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:${SEVERITY_TINT[sev]};color:${accent};font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(sev)}</span>`
    : '';
  const note = m.note
    ? `<tr><td style="padding:0 32px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="padding:12px 16px;background:#f8fafc;border-left:3px solid ${BRAND};border-radius:4px;font-size:14px;line-height:1.55;color:#334155"><div style="${p}font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#64748b;padding-bottom:4px">Message</div>${block(m.note)}</td></tr></table></td></tr>`
    : '';
  const facts = m.facts.length
    ? `<tr><td style="padding:0 32px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;line-height:1.45">${m.facts
        .map(
          (f, i) =>
            `<tr><td valign="top" style="padding:9px 16px 9px 0;width:36%;color:#64748b;${i ? 'border-top:1px solid #e2e8f0;' : ''}">${escapeHtml(f.name)}</td><td valign="top" style="padding:9px 0;color:#0f172a;${i ? 'border-top:1px solid #e2e8f0;' : ''}word-break:break-word">${block(f.value)}</td></tr>`,
        )
        .join('')}</table></td></tr>`
    : '';
  const attachments = files.length
    ? `<tr><td style="padding:0 32px 24px;font-size:13px;color:#475569">&#128206; Attached: ${files.map((f) => `<strong>${escapeHtml(f.filename)}</strong>`).join(', ')}</td></tr>`
    : '';
  const button = m.url
    ? `<tr><td style="padding:0 32px 8px"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr><td bgcolor="${BRAND}" style="border-radius:6px;background:${BRAND}"><a href="${escapeHtml(m.url)}" target="_blank" style="display:inline-block;padding:11px 22px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(action)}</a></td></tr></table></td></tr>
<tr><td style="padding:8px 32px 28px;font-size:12px;line-height:1.5;color:#64748b">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(m.url)}" style="color:${BRAND};word-break:break-all">${escapeHtml(m.url)}</a></td></tr>`
    : '<tr><td style="padding:0 32px 8px"></td></tr>';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(m.title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:${FONT};color:#0f172a">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(m.summary.replace(/\s+/g, ' ').slice(0, 140))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f1f5f9"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:600px">
<tr><td style="padding:0 4px 16px;font-size:15px;font-weight:700;color:#0f172a"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${BRAND};margin-right:8px"></span>${escapeHtml(product)}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-top:4px solid ${accent};border-radius:8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
<tr><td style="padding:28px 32px 4px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${accent}">${escapeHtml(kind.label)}${badge}</td></tr>
<tr><td style="padding:4px 32px 12px"><h1 style="${p}font-size:21px;line-height:1.3;font-weight:700;color:#0f172a">${escapeHtml(m.title)}</h1></td></tr>
<tr><td style="padding:0 32px 20px;font-size:15px;line-height:1.6;color:#334155">${block(m.summary)}</td></tr>
${note}${facts}${attachments}${button}
</table></td></tr>
<tr><td style="padding:20px 8px 0;font-size:12px;line-height:1.6;color:#94a3b8;text-align:center">${escapeHtml(why)}<br>Sent by ${escapeHtml(product)} security monitoring.</td></tr>
</table></td></tr></table></body></html>`;

  return { subject: emailSubject(`[${product}] ${m.title}`), text, html, attachments: m.attachments };
}

/** Adaptive Card payload accepted by Teams workflow webhooks ("When a Teams webhook request is received"). */
export function renderTeams(m: Message) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Medium', weight: 'Bolder', wrap: true, text: m.title, color: m.severity === 'critical' || m.severity === 'high' ? 'Attention' : 'Default' },
            { type: 'TextBlock', wrap: true, text: m.summary },
            { type: 'FactSet', facts: m.facts.map((f) => ({ title: f.name, value: f.value })) },
          ],
          ...(m.url ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Argus', url: m.url }] } : {}),
        },
      },
    ],
  };
}

/** Slack's mrkdwn treats &, < and > specially; escape them so values cannot inject links or mentions. */
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderSlack(m: Message) {
  return {
    text: `${m.title}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: m.title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: slackEscape(m.summary) } },
      ...(m.facts.length ? [{ type: 'section', fields: m.facts.slice(0, 10).map((f) => ({ type: 'mrkdwn', text: `*${slackEscape(f.name)}*\n${slackEscape(f.value)}` })) }] : []),
      ...(m.url ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Argus' }, url: m.url }] }] : []),
    ],
  };
}

/**
 * Generic JSON webhook. The signature is HMAC-SHA256 over `${timestamp}.${body}` with the channel's secret;
 * receivers should verify it and reject old timestamps to prevent replay.
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
