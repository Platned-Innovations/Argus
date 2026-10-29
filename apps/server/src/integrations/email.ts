import { createTransport } from 'nodemailer';
import { callExternal, entraToken, IntegrationError } from './outbound';
import { type EmailContent } from './messages';

export interface Envelope {
  to: string[];
  cc?: string[];
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  sender: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  authMode: 'password' | 'microsoft_oauth2' | 'none';
  username?: string | null;
  tenantId?: string | null;
  clientId?: string | null;
  from: string;
  fromName?: string | null;
}

export interface MicrosoftEndpoints {
  graph: string;
  login: string;
}

/**
 * Microsoft Graph `sendMail` with application permissions (Mail.Send), authenticated by client credentials.
 * Restrict the app to the sender mailbox with an Exchange application access policy.
 */
export async function sendViaGraph(cfg: GraphConfig, clientSecret: string, env: Envelope, content: EmailContent, ms: MicrosoftEndpoints): Promise<void> {
  const token = await entraToken(ms.login, cfg.tenantId, cfg.clientId, clientSecret, `${ms.graph}/.default`);
  const recipients = (list: string[] = []) => list.map((address) => ({ emailAddress: { address } }));
  await callExternal(`${ms.graph}/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`, {
    service: 'Microsoft Graph',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: content.subject,
        body: { contentType: 'HTML', content: content.html },
        toRecipients: recipients(env.to),
        ccRecipients: recipients(env.cc),
        // Inline file attachments (up to 3 MB in one sendMail request).
        attachments: (content.attachments ?? []).map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType, contentBytes: a.content.toString('base64') })),
      },
      saveToSentItems: true,
    }),
  });
}

/**
 * SMTP over TLS (implicit or STARTTLS — plain text is never used).
 * Microsoft 365: smtp.office365.com:587 STARTTLS, either an app password or OAuth2 (XOAUTH2) with an Entra ID app.
 * Google Workspace / Gmail: smtp.gmail.com:465 TLS with an app password.
 */
export async function sendViaSmtp(cfg: SmtpConfig, secret: string | null, env: Envelope, content: EmailContent, ms: MicrosoftEndpoints, opts: { allowSelfSigned?: boolean } = {}): Promise<void> {
  let auth: Record<string, string> | undefined;
  if (cfg.authMode === 'password') {
    if (!cfg.username || !secret) throw new IntegrationError('SMTP username and password are required.');
    auth = { user: cfg.username, pass: secret };
  } else if (cfg.authMode === 'microsoft_oauth2') {
    if (!cfg.username || !cfg.tenantId || !cfg.clientId || !secret) throw new IntegrationError('Mailbox, tenant, client id and client secret are required for Microsoft OAuth2.');
    const accessToken = await entraToken(ms.login, cfg.tenantId, cfg.clientId, secret, 'https://outlook.office365.com/.default');
    auth = { type: 'OAuth2', user: cfg.username, accessToken };
  }
  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === 'tls',
    requireTLS: cfg.security === 'starttls',
    auth,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: !opts.allowSelfSigned },
  } as Parameters<typeof createTransport>[0]);
  try {
    await transport.sendMail({
      from: cfg.fromName ? { name: cfg.fromName, address: cfg.from } : cfg.from,
      to: env.to,
      cc: env.cc?.length ? env.cc : undefined,
      subject: content.subject,
      text: content.text,
      html: content.html,
      attachments: content.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
    });
  } catch (err) {
    throw new IntegrationError(`SMTP delivery failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    transport.close();
  }
}
