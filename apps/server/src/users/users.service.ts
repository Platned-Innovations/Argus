import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type DataStore, type User, type UserPatch } from '@argus/data';
import { type CreatedUserResponse, type CreateUserInput, type ListUsersQuery, type Paged, type UpdateUserInput, type UserDto } from '@argus/shared';
import { PasswordService } from '../auth/password.service';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
import { DATA_STORE } from '../core/tokens';
import { toUserDto } from './user.mapper';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async list(q: ListUsersQuery): Promise<Paged<UserDto>> {
    const page = await this.store.users.list({
      search: q.search || undefined,
      role: q.role,
      status: q.status,
      teamId: q.teamId,
      offset: (q.page - 1) * q.pageSize,
      limit: q.pageSize,
    });
    return { items: page.items.map(toUserDto), total: page.total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string): Promise<UserDto> {
    return toUserDto(await this.require(id));
  }

  async create(input: CreateUserInput, actor: User, ctx: RequestContext): Promise<CreatedUserResponse> {
    await this.assertTeamsExist(input.teamIds);
    let password = input.password;
    let temporaryPassword: string | undefined;
    if (password) {
      const errors = await this.passwords.policyErrors(password, input.username);
      if (errors.length) throw new BadRequestException({ statusCode: 400, message: errors, code: 'PASSWORD_POLICY' });
    } else {
      password = temporaryPassword = await this.passwords.generateTemporary();
    }
    const user = await this.store.users.create({
      username: input.username,
      email: input.email ?? null,
      displayName: input.displayName,
      role: input.role,
      teamIds: input.teamIds,
      passwordHash: await this.passwords.hash(password),
      // Whoever set the initial password knows it, so the user always picks their own on first login.
      mustChangePassword: true,
    });
    await this.audit.record({
      action: 'user.created',
      actor,
      target: { type: 'user', id: user.id },
      details: { username: user.username, role: user.role, teamIds: user.teamIds },
      ip: ctx.ip,
    });
    return { user: toUserDto(user), temporaryPassword };
  }

  async update(id: string, input: UpdateUserInput, actor: User, ctx: RequestContext): Promise<UserDto> {
    const user = await this.require(id);
    const roleChanging = input.role !== undefined && input.role !== user.role;
    const disabling = input.status === 'disabled' && user.status !== 'disabled';

    if (actor.id === id && (roleChanging || disabling)) {
      throw new ForbiddenException('You cannot change your own role or disable your own account.');
    }
    if (user.role === 'admin' && user.status === 'active' && (roleChanging || disabling)) await this.assertNotLastAdmin();
    if (input.teamIds) await this.assertTeamsExist(input.teamIds);

    const patch: UserPatch = {};
    for (const key of ['email', 'displayName', 'role', 'teamIds', 'status'] as const) {
      if (input[key] !== undefined) Object.assign(patch, { [key]: input[key] });
    }
    const updated = (await this.store.users.update(id, patch))!;
    if (disabling) await this.store.sessions.revokeAllForUser(id);

    const changed = Object.keys(patch).filter((k) => JSON.stringify((user as unknown as Record<string, unknown>)[k]) !== JSON.stringify((patch as Record<string, unknown>)[k]));
    await this.audit.record({
      action: 'user.updated',
      actor,
      target: { type: 'user', id },
      details: { changed, ...(roleChanging ? { fromRole: user.role, toRole: input.role } : {}), ...(input.status ? { status: input.status } : {}) },
      ip: ctx.ip,
    });
    return toUserDto(updated);
  }

  async resetPassword(id: string, actor: User, ctx: RequestContext): Promise<{ temporaryPassword: string }> {
    const user = await this.require(id);
    const temporaryPassword = await this.passwords.generateTemporary();
    await this.store.users.update(id, {
      passwordHash: await this.passwords.hash(temporaryPassword),
      mustChangePassword: true,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    });
    await this.store.sessions.revokeAllForUser(id);
    await this.audit.record({ action: 'user.password_reset', actor, target: { type: 'user', id }, details: { username: user.username }, ip: ctx.ip });
    return { temporaryPassword };
  }

  async resetMfa(id: string, actor: User, ctx: RequestContext): Promise<UserDto> {
    await this.require(id);
    const updated = (await this.store.users.update(id, { mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaRecoveryCodes: [], mfaLastUsedStep: null }))!;
    await this.store.sessions.revokeAllForUser(id);
    await this.audit.record({ action: 'user.mfa_reset', actor, target: { type: 'user', id }, ip: ctx.ip });
    return toUserDto(updated);
  }

  async unlock(id: string, actor: User, ctx: RequestContext): Promise<UserDto> {
    await this.require(id);
    const updated = (await this.store.users.update(id, { lockedUntil: null, failedLoginCount: 0 }))!;
    await this.audit.record({ action: 'user.unlocked', actor, target: { type: 'user', id }, ip: ctx.ip });
    return toUserDto(updated);
  }

  async revokeSessions(id: string, actor: User, ctx: RequestContext): Promise<{ revoked: number }> {
    await this.require(id);
    const revoked = await this.store.sessions.revokeAllForUser(id);
    await this.audit.record({ action: 'user.sessions_revoked', actor, target: { type: 'user', id }, details: { revoked }, ip: ctx.ip });
    return { revoked };
  }

  private async require(id: string): Promise<User> {
    const user = await this.store.users.findById(id);
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  private async assertNotLastAdmin(): Promise<void> {
    const admins = await this.store.users.list({ role: 'admin', status: 'active', offset: 0, limit: 2 });
    if (admins.total <= 1) throw new ConflictException('At least one active administrator is required.');
  }

  private async assertTeamsExist(teamIds: string[]): Promise<void> {
    const unique = [...new Set(teamIds)];
    if ((await this.store.teams.findByIds(unique)).length !== unique.length) throw new BadRequestException('One or more teams do not exist.');
  }
}
