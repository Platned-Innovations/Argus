import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type DataStore } from '@argus/data';
import { hasPermission, type Permission, RESTRICTION_CODES } from '@argus/shared';
import { type Request } from 'express';
import { CryptoService } from '../core/crypto.service';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER, REFRESH_COOKIE } from './cookies';
import { ALLOW_RESTRICTED_KEY, PERMISSIONS_KEY, PUBLIC_KEY, SKIP_CSRF_KEY } from './decorators';
import { TokenService } from './token.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function flag(reflector: Reflector, key: string, ctx: ExecutionContext): boolean {
  return reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]) === true;
}

/**
 * Double-submit CSRF protection for cookie-authenticated, state-changing requests.
 * Complements SameSite=Strict cookies.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly crypto: CryptoService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method) || flag(this.reflector, SKIP_CSRF_KEY, ctx)) return true;
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    if (!cookies[ACCESS_COOKIE] && !cookies[REFRESH_COOKIE]) return true;
    const header = req.get(CSRF_HEADER);
    const cookie = cookies[CSRF_COOKIE];
    if (!header || !cookie || !this.crypto.safeEqual(header, cookie)) {
      throw new ForbiddenException({ statusCode: 403, message: 'CSRF token missing or invalid.', code: 'CSRF' });
    }
    return true;
  }
}

/** Authenticates the access-token cookie and loads the current user on every request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly settings: SettingsService,
    @Inject(DATA_STORE) private readonly store: DataStore,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http' || flag(this.reflector, PUBLIC_KEY, ctx)) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[ACCESS_COOKIE];
    if (!token) throw new UnauthorizedException();

    const claims = this.tokens.verifyAccess(token);
    // Loaded per request so disabling a user or changing a role takes effect immediately.
    const user = await this.store.users.findById(claims.sub);
    if (!user || user.status !== 'active') throw new UnauthorizedException();
    // Access tokens issued before the last password change/reset are no longer valid.
    if (user.passwordChangedAt && (claims.iat + 1) * 1000 <= user.passwordChangedAt.getTime()) throw new UnauthorizedException();

    const security = await this.settings.getSecurity();
    const mfaEnrollmentRequired = security.mfaRequired && !user.mfaEnabled;
    req.argusUser = { user, sessionId: claims.sid, mfaEnrollmentRequired };

    if (!flag(this.reflector, ALLOW_RESTRICTED_KEY, ctx)) {
      if (user.mustChangePassword) {
        throw new ForbiddenException({ statusCode: 403, message: 'You must change your password first.', code: RESTRICTION_CODES.passwordChangeRequired });
      }
      if (mfaEnrollmentRequired) {
        throw new ForbiddenException({ statusCode: 403, message: 'You must set up multi-factor authentication first.', code: RESTRICTION_CODES.mfaEnrollmentRequired });
      }
    }
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const current = ctx.switchToHttp().getRequest<Request>().argusUser;
    if (!current) throw new UnauthorizedException();
    if (!required.every((p) => hasPermission(current.user.role, p))) throw new ForbiddenException('You do not have permission to do this.');
    return true;
  }
}
