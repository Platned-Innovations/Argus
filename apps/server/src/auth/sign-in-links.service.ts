import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { type DataStore, type User } from '@argus/data';
import { isEmailChannel, SIGN_IN_LINK_MINUTES, type SignInOptionsDto } from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { ChannelsService } from '../integrations/channels.service';
import { AuthService, type LoginResult } from './auth.service';

/** A user gets at most one new link per this interval, however often one is requested. */
const RESEND_INTERVAL_MS = 60_000;
const INVALID_LINK = 'This sign-in link is invalid, has expired or was already used. Ask for a new one.';

/**
 * One-time sign-in links by email, as an alternative to the password. The link only replaces the password: users with
 * MFA still enter their code. Links are random, stored as a keyed hash, valid for SIGN_IN_LINK_MINUTES, used once, and
 * a newer link replaces older ones.
 */
@Injectable()
export class SignInLinksService {
  private readonly logger = new Logger('SignInLinks');

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly auth: AuthService,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
    private readonly channels: ChannelsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private hashToken(token: string): string {
    return this.crypto.hash(`sign-in-link:${token}`);
  }

  /**
   * Links are only offered with ARGUS_PUBLIC_URL set: building them from the request's Host header would let anyone
   * send a user a link that points at another site and leaks the token there.
   */
  async options(): Promise<SignInOptionsDto> {
    const s = await this.settings.getSecurity();
    return { signInLinks: s.signInLinks && !!s.signInLinkChannelId && !!this.config.publicUrl };
  }

  /**
   * Always returns at once, whether or not the account exists; the email is sent in the background so the response
   * time does not reveal it either.
   */
  async request(login: string, ctx: RequestContext): Promise<void> {
    if (!(await this.options()).signInLinks) return;
    void this.send(login, ctx).catch((err: unknown) => this.logger.error({ err }, 'Could not send a sign-in link'));
  }

  private async send(login: string, ctx: RequestContext): Promise<void> {
    const user = login.includes('@') ? await this.store.users.findByEmail(login) : await this.store.users.findByUsername(login);
    const refuse = (reason: string) =>
      this.audit.record({ action: 'auth.sign_in_link_requested', outcome: 'failure', target: user ? { type: 'user', id: user.id } : null, details: { login: login.slice(0, 200), reason }, ip: ctx.ip });
    if (!user) return refuse('unknown_user');
    if (user.status !== 'active') return refuse('disabled');
    if (!user.email) return refuse('no_email');
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return refuse('locked');
    const latest = await this.store.loginLinks.latestForUser(user.id);
    if (latest && Date.now() - latest.createdAt.getTime() < RESEND_INTERVAL_MS) return refuse('too_soon');

    const security = await this.settings.getSecurity();
    const channel = security.signInLinkChannelId ? await this.store.channels.findById(security.signInLinkChannelId) : null;
    if (!channel || !channel.enabled || !isEmailChannel(channel.type)) {
      this.logger.warn('Sign-in links are on, but their email channel is missing, disabled or not an email channel');
      return refuse('no_channel');
    }

    const now = new Date();
    await this.store.loginLinks.invalidateForUser(user.id, now);
    const token = this.crypto.randomToken(32);
    const expiresAt = new Date(now.getTime() + SIGN_IN_LINK_MINUTES * 60_000);
    await this.store.loginLinks.create({ userId: user.id, tokenHash: this.hashToken(token), expiresAt, requestedIp: ctx.ip });

    const product = (await this.settings.getBranding()).productName;
    await this.channels.send(
      channel,
      {
        event: 'sign_in_link',
        title: `Sign in to ${product}`,
        summary: `Use the button below to sign in as ${user.username}. The link works once and expires in ${SIGN_IN_LINK_MINUTES} minutes.${user.mfaEnabled ? ' You will still be asked for the code from your authenticator app.' : ''}`,
        severity: null,
        // The token stays in the fragment, which browsers never send to the server.
        url: `${this.config.publicUrl}/login#link=${token}`,
        facts: [
          { name: 'Account', value: user.username },
          { name: 'Requested from', value: ctx.ip ?? 'unknown' },
          { name: 'Expires', value: `${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` },
        ],
      },
      { to: [user.email] },
    );
    await this.audit.record({ action: 'auth.sign_in_link_requested', target: { type: 'user', id: user.id }, details: { channel: channel.name }, ip: ctx.ip });
  }

  async signIn(token: string, ctx: RequestContext): Promise<LoginResult> {
    const fail = async (reason: string, user: User | null) => {
      await this.audit.record({ action: 'auth.login', outcome: 'failure', target: user ? { type: 'user', id: user.id } : null, details: { method: 'sign_in_link', reason }, ip: ctx.ip });
      return new UnauthorizedException(INVALID_LINK);
    };
    if (!(await this.options()).signInLinks) throw await fail('disabled', null);
    const link = await this.store.loginLinks.consume(this.hashToken(token), new Date());
    if (!link) throw await fail('invalid_link', null);
    const user = await this.store.users.findById(link.userId);
    if (!user || user.status !== 'active') throw await fail('disabled', user);
    return this.auth.continueVerifiedLogin(user, ctx, 'sign_in_link');
  }
}
