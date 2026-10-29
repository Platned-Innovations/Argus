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

/** `product` is the installation's product name (branding). */
export function renderEmail(m: Message, product = 'Argus'): EmailContent {
  const lines = [m.summary, '', ...m.facts.map((f) => `${f.name}: ${f.value}`)];
  if (m.note) lines.unshift(m.note, '', '---', '');
  if (m.url) lines.push('', `Open in ${product}: ${m.url}`);
  const name = escapeHtml(product);
  const color = m.severity ? SEVERITY_COLOR[m.severity] : '#4f46e5';
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:640px">
${m.note ? `<p style="white-space:pre-line">${escapeHtml(m.note)}</p><hr style="border:none;border-top:1px solid #e2e8f0">` : ''}
<h2 style="margin:16px 0 4px;border-left:4px solid ${color};padding-left:8px">${escapeHtml(m.title)}</h2>
<p style="white-space:pre-line">${escapeHtml(m.summary)}</p>
<table style="border-collapse:collapse;font-size:14px">${m.facts.map((f) => `<tr><td style="padding:2px 12px 2px 0;color:#64748b">${escapeHtml(f.name)}</td><td style="padding:2px 0">${escapeHtml(f.value)}</td></tr>`).join('')}</table>
${m.url ? `<p><a href="${escapeHtml(m.url)}" style="color:#4f46e5">Open in ${name}</a></p>` : ''}
<p style="color:#94a3b8;font-size:12px">Sent by ${name} security monitoring.</p></body></html>`;
  return { subject: emailSubject(`[${product}] ${m.title}`), text: lines.join('\n'), html, attachments: m.attachments };
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
