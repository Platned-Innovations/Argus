import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CryptoService } from '../core/crypto.service';

export interface AccessClaims {
  sub: string;
  sid: string;
  iat: number;
}

export interface MfaClaims {
  sub: string;
  iat: number;
}

const ISSUER = 'argus';
const MFA_TOKEN_TTL_SECONDS = 300;

/** Short-lived signed tokens (HS256, key derived from the master key). */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
  ) {}

  signAccess(userId: string, sessionId: string, ttlMinutes: number): string {
    return this.jwt.sign({ sid: sessionId }, { subject: userId, audience: 'argus:access', expiresIn: ttlMinutes * 60, ...this.signing() });
  }

  verifyAccess(token: string): AccessClaims {
    return this.verify<AccessClaims>(token, 'argus:access');
  }

  /** Proves the password step succeeded; exchanged for a session once the second factor is verified. */
  signMfa(userId: string): string {
    return this.jwt.sign({}, { subject: userId, audience: 'argus:mfa', expiresIn: MFA_TOKEN_TTL_SECONDS, ...this.signing() });
  }

  verifyMfa(token: string): MfaClaims {
    return this.verify<MfaClaims>(token, 'argus:mfa');
  }

  private signing() {
    return { secret: this.crypto.jwtSecret, issuer: ISSUER, algorithm: 'HS256' as const };
  }

  private verify<T extends object>(token: string, audience: string): T {
    try {
      return this.jwt.verify<T>(token, { secret: this.crypto.jwtSecret, issuer: ISSUER, audience, algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
