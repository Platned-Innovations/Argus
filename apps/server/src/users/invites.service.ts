import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type DataStore, DuplicateKeyError, type Invite, type User } from '@argus/data';
import {
  type InviteAcceptInput,
  type InviteCreatedDto,
  type InviteCreateInput,
  type InviteDto,
  type InvitePreviewDto,
  type InviteSendInput,
  type InviteSendResultDto,
  type InviteStatus,
  isEmailChannel,
  MAX_INVITE_DAYS,
  ROLE_LABELS,
} from '@argus/shared';
import { PasswordService } from '../auth/password.service';
import { type RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { ChannelsService } from '../integrations/channels.service';

const DAY = 86_400_000;
/** One message for unknown, used, expired and revoked links, so a guessed token reveals nothing. */
const INVALID = 'This invite link is invalid or has expired. Ask an administrator for a new one.';

export function inviteStatus(i: Invite, now = new Date()): InviteStatus {
  if (i.revokedAt) return 'revoked';
  if (i.uses >= i.maxUses) return 'used';
  if (i.expiresAt <= now) return 'expired';
  return 'active';
}

/** The link for one recipient: the token (and the address, to fill in the form) stay in the fragment. */
function inviteUrl(base: string, token: string, email?: string): string {
  return `${base.replace(/\/+$/, '')}/invite#${token}${email ? `&email=${encodeURIComponent(email)}` : ''}`;
}

/**
 * Invite links: random, shown once, stored only as a keyed hash; each creates accounts with a preset role and teams.
 * An invite can be limited to a list of addresses (each usable once), and emailed to them.
 */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly crypto: CryptoService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
    private readonly channels: ChannelsService,
  ) {}

  private hashToken(token: string): string {
    return this.crypto.hash(`invite:${token}`);
  }

  private toDto(i: Invite, names: Map<string, string>): InviteDto {
    return {
      id: i.id,
      role: i.role,
      teamIds: i.teamIds,
      emails: i.emails,
      usedEmails: i.usedEmails,
      maxUses: i.maxUses,
      uses: i.uses,
      expiresAt: i.expiresAt.toISOString(),
      note: i.note,
      status: inviteStatus(i),
      createdBy: i.createdBy,
      createdByName: i.createdBy ? (names.get(i.createdBy) ?? null) : null,
      createdAt: i.createdAt.toISOString(),
      lastUsedAt: i.lastUsedAt?.toISOString() ?? null,
      revokedAt: i.revokedAt?.toISOString() ?? null,
    };
  }

  async list(): Promise<InviteDto[]> {
    const invites = await this.store.invites.list();
    const users = await Promise.all([...new Set(invites.map((i) => i.createdBy).filter((id): id is string => !!id))].map((id) => this.store.users.findById(id)));
    const names = new Map(users.filter((u): u is User => !!u).map((u) => [u.id, u.displayName]));
    return invites.map((i) => this.toDto(i, names));
  }

  async create(input: InviteCreateInput, actor: User, ctx: RequestContext): Promise<InviteCreatedDto> {
    const now = Date.now();
    if (input.expiresAt.getTime() <= now + 60_000) throw new BadRequestException('The expiry must be in the future.');
    if (input.expiresAt.getTime() > now + MAX_INVITE_DAYS * DAY) throw new BadRequestException(`An invite can be valid for at most ${MAX_INVITE_DAYS} days.`);
    const teamIds = [...new Set(input.teamIds)];
    if ((await this.store.teams.findByIds(teamIds)).length !== teamIds.length) throw new BadRequestException('One or more teams do not exist.');
    const emails = [...new Set(input.emails.map((e) => e.toLowerCase()))];
    const taken = (await Promise.all(emails.map(async (e) => ((await this.store.users.findByEmail(e)) ? e : null)))).filter((e): e is string => !!e);
    if (taken.length) throw new ConflictException(`These addresses already have an account: ${taken.join(', ')}.`);

    const token = this.crypto.randomToken(32);
    const invite = await this.store.invites.create({
      tokenHash: this.hashToken(token),
      role: input.role,
      teamIds,
      emails,
      maxUses: emails.length || input.maxUses,
      expiresAt: input.expiresAt,
      note: input.note,
      createdBy: actor.id,
    });
    await this.audit.record({
      action: 'invite.created',
      actor,
      target: { type: 'invite', id: invite.id },
      details: { role: invite.role, teamIds, emails, maxUses: invite.maxUses, expiresAt: invite.expiresAt.toISOString() },
      ip: ctx.ip,
    });
    return {
      invite: this.toDto(invite, new Map([[actor.id, actor.displayName]])),
      token,
      url: this.config.publicUrl ? inviteUrl(this.config.publicUrl, token) : null,
    };
  }

  async revoke(id: string, actor: User, ctx: RequestContext): Promise<void> {
    const invite = await this.store.invites.findById(id);
    if (!invite) throw new NotFoundException('Invite not found.');
    if (!(await this.store.invites.revoke(id))) return;
    await this.audit.record({ action: 'invite.revoked', actor, target: { type: 'invite', id }, details: { role: invite.role, emails: invite.emails }, ip: ctx.ip });
  }

  /** Emails each invited address that has not signed up yet its own link, one message per recipient. */
  async send(id: string, input: InviteSendInput, actor: User, ctx: RequestContext): Promise<InviteSendResultDto> {
    const invite = await this.store.invites.findById(id);
    if (!invite || invite.tokenHash !== this.hashToken(input.token)) throw new NotFoundException('Invite not found.');
    if (inviteStatus(invite) !== 'active') throw new BadRequestException('This invite can no longer be used.');
    const only = input.only?.map((e) => e.toLowerCase());
    const recipients = invite.emails.filter((e) => !invite.usedEmails.includes(e) && (!only || only.includes(e)));
    if (!recipients.length) throw new BadRequestException('This invite has no addresses to email. Copy the link instead.');
    const base = this.config.publicUrl ?? input.baseUrl;
    if (!base) throw new BadRequestException('Set ARGUS_PUBLIC_URL so emailed links point to this installation.');
    const channel = await this.channels.require(input.channelId);
    if (!isEmailChannel(channel.type)) throw new NotFoundException('Email channel not found.');

    const product = (await this.settings.getBranding()).productName;
    const teams = (await this.store.teams.findByIds(invite.teamIds)).map((t) => t.name).sort((a, b) => a.localeCompare(b));
    const result: InviteSendResultDto = { sent: [], failed: [] };
    for (const email of recipients) {
      try {
        await this.channels.send(
          channel,
          {
            event: 'invite',
            title: `You are invited to ${product}`,
            summary: `${actor.displayName} invited you to join ${product} as ${ROLE_LABELS[invite.role]}. Open the link to choose your username and password.`,
            severity: null,
            url: inviteUrl(base, input.token, email),
            facts: [
              { name: 'Role', value: ROLE_LABELS[invite.role] },
              ...(teams.length ? [{ name: 'Teams', value: teams.join(', ') }] : []),
              { name: 'Link expires', value: `${invite.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` },
            ],
            note: input.message || null,
          },
          { to: [email] },
        );
        result.sent.push(email);
      } catch (err) {
        result.failed.push({ email, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.audit.record({ action: 'invite.emailed', actor, target: { type: 'invite', id }, details: { channel: channel.name, sent: result.sent, failed: result.failed.map((f) => f.email) }, ip: ctx.ip });
    return result;
  }

  private async findUsable(token: string): Promise<Invite> {
    const invite = await this.store.invites.findByHash(this.hashToken(token));
    if (!invite || inviteStatus(invite) !== 'active') throw new NotFoundException(INVALID);
    return invite;
  }

  async preview(token: string): Promise<InvitePreviewDto> {
    const invite = await this.findUsable(token);
    const teams = (await this.store.teams.findByIds(invite.teamIds)).map((t) => t.name).sort((a, b) => a.localeCompare(b));
    return { role: invite.role, teams, emailRequired: invite.emails.length > 0, expiresAt: invite.expiresAt.toISOString() };
  }

  /** Creates the account. The invitee chose the password, so there is no forced change at first sign-in. */
  async accept(input: InviteAcceptInput, ctx: RequestContext): Promise<{ username: string }> {
    const invite = await this.findUsable(input.token);
    const email = input.email?.toLowerCase() ?? null;
    const limited = invite.emails.length > 0;
    if (limited && (!email || !invite.emails.includes(email) || invite.usedEmails.includes(email))) {
      throw new ForbiddenException('This invite is not for this email address, or that address has already signed up. Use the address the invite was sent to.');
    }
    const errors = await this.passwords.policyErrors(input.password, input.username);
    if (errors.length) throw new BadRequestException({ statusCode: 400, message: errors, code: 'PASSWORD_POLICY' });
    if (await this.store.users.findByUsername(input.username)) throw new ConflictException('This username is taken. Choose another.');
    if (email && (await this.store.users.findByEmail(email))) throw new ConflictException('An account with this email already exists. Sign in instead.');
    const passwordHash = await this.passwords.hash(input.password);
    // Teams deleted since the invite was made are dropped rather than failing the sign-up.
    const teamIds = (await this.store.teams.findByIds(invite.teamIds)).map((t) => t.id);

    const used = limited ? email : null;
    if (!(await this.store.invites.consume(invite.id, new Date(), used))) throw new NotFoundException(INVALID);
    let user: User;
    try {
      user = await this.store.users.create({ username: input.username, email, displayName: input.displayName, role: invite.role, teamIds, passwordHash, mustChangePassword: false });
    } catch (err) {
      await this.store.invites.release(invite.id, used);
      if (err instanceof DuplicateKeyError) throw new ConflictException('This username or email is already in use.');
      throw err;
    }
    await this.audit.record({
      action: 'user.created',
      actor: user,
      target: { type: 'user', id: user.id },
      details: { username: user.username, role: user.role, teamIds: user.teamIds, via: 'invite', inviteId: invite.id },
      ip: ctx.ip,
    });
    return { username: user.username };
  }
}
