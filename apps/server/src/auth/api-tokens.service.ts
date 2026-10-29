import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type ApiToken, type DataStore, type User } from '@argus/data';
import { API_TOKEN_PREFIX, type ApiTokenCreatedDto, type ApiTokenCreateInput, type ApiTokenDto, hasPermission, type Permission, permissionsFor } from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { DATA_STORE } from '../core/tokens';

const DAY = 86_400_000;
/** Last-use timestamps are written at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;
/** Shown in lists so people can tell tokens apart; reveals nothing usable. */
const PREFIX_LENGTH = API_TOKEN_PREFIX.length + 6;

/** Personal API tokens: random, shown once, stored only as a keyed hash, scoped and expiring. */
@Injectable()
export class ApiTokensService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  hashToken(token: string): string {
    return this.crypto.hash(`api-token:${token}`);
  }

  private async toDto(t: ApiToken, names?: Map<string, string>): Promise<ApiTokenDto> {
    const userName = names ? (names.get(t.userId) ?? null) : ((await this.store.users.findById(t.userId))?.displayName ?? null);
    return {
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: t.scopes,
      userId: t.userId,
      userName,
      expiresAt: t.expiresAt.toISOString(),
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: t.lastUsedIp,
      revokedAt: t.revokedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  async create(input: ApiTokenCreateInput, actor: User, ctx: RequestContext): Promise<ApiTokenCreatedDto> {
    const scopes = [...new Set(input.scopes)];
    const notHeld = scopes.filter((s) => !hasPermission(actor.role, s));
    if (notHeld.length) throw new BadRequestException(`Your role does not have: ${notHeld.join(', ')}. A token can only use permissions you have.`);
    const token = `${API_TOKEN_PREFIX}${this.crypto.randomToken(32)}`;
    const t = await this.store.apiTokens.create({
      userId: actor.id,
      name: input.name,
      tokenHash: this.hashToken(token),
      prefix: token.slice(0, PREFIX_LENGTH),
      scopes,
      expiresAt: new Date(Date.now() + input.expiresInDays * DAY),
    });
    await this.audit.record({ action: 'api_token.created', actor, target: { type: 'api_token', id: t.id }, details: { name: t.name, scopes, expiresAt: t.expiresAt.toISOString() }, ip: ctx.ip });
    return { ...(await this.toDto(t)), token };
  }

  async listMine(user: User): Promise<ApiTokenDto[]> {
    return Promise.all((await this.store.apiTokens.listForUser(user.id)).map((t) => this.toDto(t, new Map([[user.id, user.displayName]]))));
  }

  async listAll(): Promise<ApiTokenDto[]> {
    const tokens = await this.store.apiTokens.listAll();
    const users = await Promise.all([...new Set(tokens.map((t) => t.userId))].map((id) => this.store.users.findById(id)));
    const names = new Map(users.filter((u): u is User => !!u).map((u) => [u.id, u.displayName]));
    return Promise.all(tokens.map((t) => this.toDto(t, names)));
  }

  /** Owners revoke their own tokens; administrators (users:manage) can revoke anyone's. */
  async revoke(id: string, actor: User, ctx: RequestContext): Promise<void> {
    const t = await this.store.apiTokens.findById(id);
    if (!t || (t.userId !== actor.id && !hasPermission(actor.role, 'users:manage'))) throw new NotFoundException('Token not found.');
    if (!(await this.store.apiTokens.revoke(id))) return;
    await this.audit.record({ action: 'api_token.revoked', actor, target: { type: 'api_token', id }, details: { name: t.name, owner: t.userId }, ip: ctx.ip });
  }

  /**
   * Resolves a bearer token to its owner. Returns null for unknown, revoked or expired tokens, and for disabled
   * users. The token's effective permissions are its scopes limited to the owner's current role.
   */
  async authenticate(token: string, ip: string | null): Promise<{ user: User; token: ApiToken; scopes: Permission[] } | null> {
    if (!token.startsWith(API_TOKEN_PREFIX) || token.length > 200) return null;
    const t = await this.store.apiTokens.findByHash(this.hashToken(token));
    const now = new Date();
    if (!t || t.revokedAt || t.expiresAt <= now) return null;
    const user = await this.store.users.findById(t.userId);
    if (!user || user.status !== 'active') return null;
    if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) await this.store.apiTokens.touch(t.id, now, ip);
    const role = new Set<Permission>(permissionsFor(user.role));
    return { user, token: t, scopes: t.scopes.filter((s) => role.has(s)) };
  }

}
