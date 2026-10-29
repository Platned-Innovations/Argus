import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type DataStore, DuplicateKeyError, type Invite, type User } from '@argus/data';
import { type InviteAcceptInput, type InviteCreatedDto, type InviteCreateInput, type InviteDto, type InvitePreviewDto, type InviteStatus, MAX_INVITE_DAYS } from '@argus/shared';
import { PasswordService } from '../auth/password.service';
import { type RequestContext } from '../common/request';
import { AppConfig } from '../config/app-config';
import { AuditService } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { DATA_STORE } from '../core/tokens';

const DAY = 86_400_000;
/** One message for unknown, used, expired and revoked links, so a guessed token reveals nothing. */
const INVALID = 'This invite link is invalid or has expired. Ask an administrator for a new one.';

export function inviteStatus(i: Invite, now = new Date()): InviteStatus {
  if (i.revokedAt) return 'revoked';
  if (i.uses >= i.maxUses) return 'used';
  if (i.expiresAt <= now) return 'expired';
  return 'active';
}

/** Invite links: random, shown once, stored only as a keyed hash; each creates accounts with a preset role and teams. */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly crypto: CryptoService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  private hashToken(token: string): string {
    return this.crypto.hash(`invite:${token}`);
  }

  private toDto(i: Invite, names: Map<string, string>): InviteDto {
    return {
      id: i.id,
      role: i.role,
      teamIds: i.teamIds,
      email: i.email,
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
    if (input.email && input.maxUses > 1) throw new BadRequestException('An invite for a specific email address can be used once.');
    const teamIds = [...new Set(input.teamIds)];
    if ((await this.store.teams.findByIds(teamIds)).length !== teamIds.length) throw new BadRequestException('One or more teams do not exist.');
    if (input.email && (await this.store.users.findByEmail(input.email))) throw new ConflictException('A user with this email already exists.');

    const token = this.crypto.randomToken(32);
    const invite = await this.store.invites.create({
      tokenHash: this.hashToken(token),
      role: input.role,
      teamIds,
      email: input.email,
      maxUses: input.maxUses,
      expiresAt: input.expiresAt,
      note: input.note,
      createdBy: actor.id,
    });
    await this.audit.record({
      action: 'invite.created',
      actor,
      target: { type: 'invite', id: invite.id },
      details: { role: invite.role, teamIds, email: invite.email, maxUses: invite.maxUses, expiresAt: invite.expiresAt.toISOString() },
      ip: ctx.ip,
    });
    return {
      invite: this.toDto(invite, new Map([[actor.id, actor.displayName]])),
      token,
      url: this.config.publicUrl ? `${this.config.publicUrl}/invite#${token}` : null,
    };
  }

  async revoke(id: string, actor: User, ctx: RequestContext): Promise<void> {
    const invite = await this.store.invites.findById(id);
    if (!invite) throw new NotFoundException('Invite not found.');
    if (!(await this.store.invites.revoke(id))) return;
    await this.audit.record({ action: 'invite.revoked', actor, target: { type: 'invite', id }, details: { role: invite.role, email: invite.email }, ip: ctx.ip });
  }

  private async findUsable(token: string): Promise<Invite> {
    const invite = await this.store.invites.findByHash(this.hashToken(token));
    if (!invite || inviteStatus(invite) !== 'active') throw new NotFoundException(INVALID);
    return invite;
  }

  async preview(token: string): Promise<InvitePreviewDto> {
    const invite = await this.findUsable(token);
    const teams = (await this.store.teams.findByIds(invite.teamIds)).map((t) => t.name).sort((a, b) => a.localeCompare(b));
    return { role: invite.role, teams, email: invite.email, expiresAt: invite.expiresAt.toISOString() };
  }

  /** Creates the account. The invitee chose the password, so there is no forced change at first sign-in. */
  async accept(input: InviteAcceptInput, ctx: RequestContext): Promise<{ username: string }> {
    const invite = await this.findUsable(input.token);
    const email = invite.email ?? input.email;
    const errors = await this.passwords.policyErrors(input.password, input.username);
    if (errors.length) throw new BadRequestException({ statusCode: 400, message: errors, code: 'PASSWORD_POLICY' });
    if (await this.store.users.findByUsername(input.username)) throw new ConflictException('This username is taken. Choose another.');
    if (email && (await this.store.users.findByEmail(email))) throw new ConflictException('An account with this email already exists. Sign in instead.');
    const passwordHash = await this.passwords.hash(input.password);
    // Teams deleted since the invite was made are dropped rather than failing the sign-up.
    const teamIds = (await this.store.teams.findByIds(invite.teamIds)).map((t) => t.id);

    if (!(await this.store.invites.consume(invite.id, new Date()))) throw new NotFoundException(INVALID);
    let user: User;
    try {
      user = await this.store.users.create({ username: input.username, email, displayName: input.displayName, role: invite.role, teamIds, passwordHash, mustChangePassword: false });
    } catch (err) {
      await this.store.invites.release(invite.id);
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
