import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Channel, type DataStore, type User } from '@argus/data';
import { type ChannelDto, type ChannelInput, type ConnectionTestDto, isEmailChannel } from '@argus/shared';
import { Redactor } from '../common/redact';
import { type RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { DATA_STORE } from '../core/tokens';
import { type Envelope, type GraphConfig, sendViaGraph, sendViaSmtp, type SmtpConfig } from './email';
import { type Message, renderEmail, renderSlack, renderTeams, signWebhook } from './messages';
import { callExternal, IntegrationError } from './outbound';

function hint(secret: string): string {
  // For webhook URLs show nothing of the token-bearing path; for passwords/keys the last 4 characters.
  return secret.startsWith('https://') ? `${new URL(secret).host}/…` : `••••${secret.slice(-4)}`;
}

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  toDto(c: Channel): ChannelDto {
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled,
      config: c.config,
      secretConfigured: !!c.secretEnc,
      secretHint: c.secretHint,
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      lastError: c.lastError,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  async list(): Promise<ChannelDto[]> {
    return (await this.store.channels.list()).map((c) => this.toDto(c));
  }

  /** Email channels, for the "send email" dialog (names only; no configuration). */
  async emailChannels(): Promise<{ id: string; name: string }[]> {
    return (await this.store.channels.list()).filter((c) => c.enabled && isEmailChannel(c.type)).map((c) => ({ id: c.id, name: c.name }));
  }

  async require(id: string): Promise<Channel> {
    const c = await this.store.channels.findById(id);
    if (!c) throw new NotFoundException('Channel not found.');
    return c;
  }

  private assertSecret(input: ChannelInput, existing: Channel | null): void {
    const needsSecret = input.type !== 'email_smtp' || input.config.authMode !== 'none';
    if (needsSecret && !input.secret && !existing?.secretEnc) {
      const what = { email_graph: 'client secret', email_smtp: 'password or client secret', teams_webhook: 'webhook URL', slack_webhook: 'webhook URL', webhook: 'signing secret' }[input.type];
      throw new BadRequestException(`The ${what} is required.`);
    }
  }

  async create(input: ChannelInput, actor: User, ctx: RequestContext): Promise<ChannelDto> {
    this.assertSecret(input, null);
    const c = await this.store.channels.create({
      name: input.name,
      type: input.type,
      enabled: input.enabled,
      config: input.config,
      secretEnc: input.secret ? this.crypto.encrypt(input.secret) : null,
      secretHint: input.secret ? hint(input.secret) : null,
    });
    await this.audit.record({ action: 'channel.created', actor, target: { type: 'channel', id: c.id }, details: { name: c.name, type: c.type }, ip: ctx.ip });
    return this.toDto(c);
  }

  async update(id: string, input: ChannelInput, actor: User, ctx: RequestContext): Promise<ChannelDto> {
    const existing = await this.require(id);
    if (existing.type !== input.type) throw new BadRequestException('The channel type cannot be changed.');
    this.assertSecret(input, existing);
    const c = (await this.store.channels.update(id, {
      name: input.name,
      enabled: input.enabled,
      config: input.config,
      ...(input.secret ? { secretEnc: this.crypto.encrypt(input.secret), secretHint: hint(input.secret) } : {}),
    }))!;
    await this.audit.record({ action: 'channel.updated', actor, target: { type: 'channel', id }, details: { name: c.name, secretRotated: !!input.secret }, ip: ctx.ip });
    return this.toDto(c);
  }

  async remove(id: string, actor: User, ctx: RequestContext): Promise<void> {
    const c = await this.require(id);
    await this.store.channels.delete(id);
    // Rules keep working with their remaining channels.
    for (const r of await this.store.notificationRules.list()) {
      if (r.channelIds.includes(id)) await this.store.notificationRules.update(r.id, { channelIds: r.channelIds.filter((x) => x !== id) });
    }
    await this.audit.record({ action: 'channel.deleted', actor, target: { type: 'channel', id }, details: { name: c.name }, ip: ctx.ip });
  }

  async test(id: string, to: string | undefined, actor: User, ctx: RequestContext): Promise<ConnectionTestDto> {
    const c = await this.require(id);
    if (isEmailChannel(c.type) && !to) throw new BadRequestException('Enter an email address to send the test message to.');
    const message: Message = {
      event: 'test',
      title: 'Test message',
      summary: `This is a test from Argus, sent by ${actor.displayName}. If you can read it, the "${c.name}" channel works.`,
      severity: null,
      url: this.config.publicUrl ?? null,
      facts: [{ name: 'Channel', value: c.name }],
    };
    try {
      await this.send(c, message, { to: to ? [to] : [] });
      await this.audit.record({ action: 'channel.tested', actor, target: { type: 'channel', id }, details: { ok: true }, ip: ctx.ip });
      return { ok: true, message: isEmailChannel(c.type) ? `Test email sent to ${to}.` : 'Test message delivered.' };
    } catch (err) {
      await this.audit.record({ action: 'channel.tested', actor, target: { type: 'channel', id }, outcome: 'failure', ip: ctx.ip });
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Delivers a message through a channel and records success or the (redacted) error on the channel.
   * Email channels need recipients; webhook channels ignore them.
   */
  async send(c: Channel, message: Message, envelope: Envelope): Promise<void> {
    const secret = c.secretEnc ? this.crypto.decrypt(c.secretEnc) : null;
    const redactor = new Redactor([secret]);
    try {
      if (!c.enabled) throw new IntegrationError('The channel is disabled.');
      switch (c.type) {
        case 'email_graph':
        case 'email_smtp': {
          if (!envelope.to.length) throw new IntegrationError('No recipients.');
          const content = renderEmail(message);
          if (c.type === 'email_graph') await sendViaGraph(c.config as unknown as GraphConfig, secret!, envelope, content, this.config.microsoft);
          else await sendViaSmtp(c.config as unknown as SmtpConfig, secret, envelope, content, this.config.microsoft, { allowSelfSigned: !this.config.isProduction && c.config.host === '127.0.0.1' });
          break;
        }
        case 'teams_webhook':
          await callExternal(secret!, { service: 'Microsoft Teams', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(renderTeams(message)) });
          break;
        case 'slack_webhook':
          await callExternal(secret!, { service: 'Slack', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(renderSlack(message)) });
          break;
        case 'webhook': {
          const body = JSON.stringify({ event: message.event, title: message.title, summary: message.summary, severity: message.severity, url: message.url, facts: message.facts, sentAt: new Date().toISOString() });
          const timestamp = Math.floor(Date.now() / 1000);
          await callExternal(String(c.config.url), {
            service: 'Webhook',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Argus', 'X-Argus-Event': message.event, 'X-Argus-Timestamp': String(timestamp), 'X-Argus-Signature': signWebhook(secret!, body, timestamp) },
            body,
          });
          break;
        }
      }
      await this.store.channels.update(c.id, { lastUsedAt: new Date(), lastError: null });
    } catch (err) {
      const msg = redactor.redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.store.channels.update(c.id, { lastError: msg });
      throw new IntegrationError(msg);
    }
  }
}
