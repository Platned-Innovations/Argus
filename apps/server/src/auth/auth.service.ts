import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type DataStore, type User } from '@argus/data';
import { type MfaSetupResponse } from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
import { CryptoService } from '../core/crypto.service';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { type IssuedTokens } from './cookies';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/** A rotated refresh token presented again within this window is treated as a benign race (e.g. two tabs), not theft. */
const REFRESH_REUSE_GRACE_MS = 30_000;

const INVALID_CREDENTIALS = 'Invalid username or password.';

export type LoginResult = { kind: 'session'; user: User; tokens: IssuedTokens } | { kind: 'mfa'; mfaToken: string };

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async login(identifier: string, password: string, ctx: RequestContext): Promise<LoginResult> {
    const user = identifier.includes('@') ? await this.store.users.findByEmail(identifier) : await this.store.users.findByUsername(identifier);

    if (!user || user.status !== 'active') {
      await this.passwords.burnTime(password);
      await this.audit.record({
        action: 'auth.login',
        outcome: 'failure',
        target: user ? { type: 'user', id: user.id } : null,
        details: { identifier: identifier.slice(0, 200), reason: user ? 'disabled' : 'unknown_user' },
        ip: ctx.ip,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    this.assertNotLocked(user);

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.registerFailure(user, 'bad_password', ctx);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (user.mfaEnabled) return { kind: 'mfa', mfaToken: this.tokens.signMfa(user.id) };
    return this.completeLogin(user, ctx, 'password');
  }

  async verifyMfaLogin(mfaToken: string, code: string, ctx: RequestContext): Promise<LoginResult> {
    const claims = this.tokens.verifyMfa(mfaToken);
    const user = await this.store.users.findById(claims.sub);
    if (!user || user.status !== 'active' || !user.mfaEnabled || !user.mfaSecretEnc) throw new UnauthorizedException('Invalid or expired token');
    this.assertNotLocked(user);

    const method = await this.checkSecondFactor(user, code);
    if (!method) {
      await this.registerFailure(user, 'bad_mfa_code', ctx);
      throw new UnauthorizedException('Invalid verification code.');
    }
    return this.completeLogin(user, ctx, method);
  }

  async refresh(rawToken: string | undefined, ctx: RequestContext): Promise<{ user: User; tokens: IssuedTokens }> {
    if (!rawToken) throw new UnauthorizedException();
    const session = await this.store.sessions.findByTokenHash(this.crypto.hash(rawToken));
    if (!session) throw new UnauthorizedException();

    if (session.revokedAt) {
      if (Date.now() - session.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
        // A rotated token was replayed: assume it was stolen and kill the whole chain.
        const revoked = await this.store.sessions.revokeFamily(session.familyId);
        await this.audit.record({
          action: 'auth.refresh_token_reuse',
          outcome: 'failure',
          target: { type: 'user', id: session.userId },
          details: { sessionsRevoked: revoked },
          ip: ctx.ip,
        });
      }
      throw new UnauthorizedException();
    }
    if (session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException();

    const user = await this.store.users.findById(session.userId);
    if (!user || user.status !== 'active') {
      await this.store.sessions.revokeFamily(session.familyId);
      throw new UnauthorizedException();
    }
    // Only one concurrent refresh may win the rotation.
    if (!(await this.store.sessions.revokeIfActive(session.id))) throw new UnauthorizedException();
    return { user, tokens: await this.issueSession(user, ctx, session.familyId) };
  }

  async logout(rawToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (!rawToken) return;
    const session = await this.store.sessions.findByTokenHash(this.crypto.hash(rawToken));
    if (session && (await this.store.sessions.revokeIfActive(session.id))) {
      await this.audit.record({ action: 'auth.logout', actor: null, target: { type: 'user', id: session.userId }, ip: ctx.ip });
    }
  }

  async changePassword(user: User, currentPassword: string, newPassword: string, ctx: RequestContext): Promise<{ user: User; tokens: IssuedTokens }> {
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      await this.registerFailure(user, 'bad_current_password', ctx);
      throw new BadRequestException({ statusCode: 400, message: 'Current password is incorrect.', code: 'BAD_CURRENT_PASSWORD' });
    }
    const errors = await this.passwords.policyErrors(newPassword, user.username);
    if (newPassword === currentPassword) errors.push('Must differ from the current password.');
    if (errors.length) throw new BadRequestException({ statusCode: 400, message: errors, code: 'PASSWORD_POLICY' });

    const updated = (await this.store.users.update(user.id, {
      passwordHash: await this.passwords.hash(newPassword),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
    }))!;
    // Every other session (and every older access token, via passwordChangedAt) stops working.
    await this.store.sessions.revokeAllForUser(user.id);
    await this.audit.record({ action: 'auth.password_changed', actor: updated, target: { type: 'user', id: user.id }, ip: ctx.ip });
    return { user: updated, tokens: await this.issueSession(updated, ctx) };
  }

  async beginMfaEnrollment(user: User): Promise<MfaSetupResponse> {
    if (user.mfaEnabled) throw new ConflictException('MFA is already enabled.');
    const secret = this.mfa.generateSecret();
    await this.store.users.update(user.id, { mfaPendingSecretEnc: this.crypto.encrypt(secret) });
    return this.mfa.enrollment(user.username, secret);
  }

  async confirmMfaEnrollment(user: User, code: string, ctx: RequestContext): Promise<string[]> {
    if (user.mfaEnabled) throw new ConflictException('MFA is already enabled.');
    if (!user.mfaPendingSecretEnc) throw new BadRequestException('Start MFA setup first.');
    const step = this.mfa.verifyTotp(user.mfaPendingSecretEnc, code, null);
    if (step === null) throw new BadRequestException('Invalid verification code.');
    const { codes, hashes } = this.mfa.generateRecoveryCodes();
    await this.store.users.update(user.id, {
      mfaEnabled: true,
      mfaSecretEnc: user.mfaPendingSecretEnc,
      mfaPendingSecretEnc: null,
      mfaRecoveryCodes: hashes,
      mfaLastUsedStep: step,
    });
    await this.audit.record({ action: 'auth.mfa_enabled', actor: user, target: { type: 'user', id: user.id }, ip: ctx.ip });
    return codes;
  }

  async disableMfa(user: User, password: string, code: string, ctx: RequestContext): Promise<void> {
    if ((await this.settings.getSecurity()).mfaRequired) throw new ForbiddenException('MFA is required by policy and cannot be disabled.');
    if (!user.mfaEnabled) return;
    const passwordOk = await this.passwords.verify(user.passwordHash, password);
    if (!passwordOk || !(await this.checkSecondFactor(user, code))) {
      await this.registerFailure(user, 'bad_mfa_disable', ctx);
      throw new BadRequestException('Password or verification code is incorrect.');
    }
    await this.store.users.update(user.id, { mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaRecoveryCodes: [], mfaLastUsedStep: null });
    await this.audit.record({ action: 'auth.mfa_disabled', actor: user, target: { type: 'user', id: user.id }, ip: ctx.ip });
  }

  /** Returns which factor matched, consuming a recovery code if one was used. */
  private async checkSecondFactor(user: User, code: string): Promise<'totp' | 'recovery_code' | null> {
    if (!user.mfaSecretEnc) return null;
    const step = this.mfa.verifyTotp(user.mfaSecretEnc, code, user.mfaLastUsedStep);
    if (step !== null) {
      await this.store.users.update(user.id, { mfaLastUsedStep: step });
      return 'totp';
    }
    const remaining = this.mfa.consumeRecoveryCode(user.mfaRecoveryCodes, code);
    if (remaining) {
      await this.store.users.update(user.id, { mfaRecoveryCodes: remaining });
      return 'recovery_code';
    }
    return null;
  }

  private assertNotLocked(user: User): void {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new HttpException(
        { statusCode: HttpStatus.LOCKED, message: 'Account is temporarily locked after too many failed attempts. Try again later.', code: 'ACCOUNT_LOCKED' },
        HttpStatus.LOCKED,
      );
    }
  }

  private async registerFailure(user: User, reason: string, ctx: RequestContext): Promise<void> {
    const security = await this.settings.getSecurity();
    const failures = await this.store.users.incrementFailedLogins(user.id);
    await this.audit.record({ action: 'auth.login', outcome: 'failure', target: { type: 'user', id: user.id }, details: { reason, failures }, ip: ctx.ip });
    if (failures >= security.lockoutThreshold) {
      const lockedUntil = new Date(Date.now() + security.lockoutMinutes * 60_000);
      await this.store.users.update(user.id, { lockedUntil, failedLoginCount: 0 });
      await this.audit.record({
        action: 'auth.account_locked',
        outcome: 'failure',
        target: { type: 'user', id: user.id },
        details: { until: lockedUntil.toISOString(), failures },
        ip: ctx.ip,
      });
    }
  }

  private async completeLogin(user: User, ctx: RequestContext, method: string): Promise<LoginResult> {
    const updated = (await this.store.users.update(user.id, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }))!;
    const tokens = await this.issueSession(updated, ctx);
    await this.audit.record({ action: 'auth.login', actor: updated, target: { type: 'user', id: user.id }, details: { method }, ip: ctx.ip });
    return { kind: 'session', user: updated, tokens };
  }

  private async issueSession(user: User, ctx: RequestContext, familyId: string = randomUUID()): Promise<IssuedTokens> {
    const security = await this.settings.getSecurity();
    const refreshToken = this.crypto.randomToken();
    const refreshMaxAgeMs = security.sessionDays * 86_400_000;
    const session = await this.store.sessions.create({
      userId: user.id,
      tokenHash: this.crypto.hash(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + refreshMaxAgeMs),
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });
    return {
      accessToken: this.tokens.signAccess(user.id, session.id, security.accessTokenMinutes),
      accessMaxAgeMs: security.accessTokenMinutes * 60_000,
      refreshToken,
      refreshMaxAgeMs,
      csrfToken: this.crypto.randomToken(24),
    };
  }
}
