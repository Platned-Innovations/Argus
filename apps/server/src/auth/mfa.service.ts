import { Injectable } from '@nestjs/common';
import { toDataURL } from 'qrcode';
import { CryptoService } from '../core/crypto.service';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp';

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** TOTP (RFC 6238) and one-time recovery codes. Secrets are only ever stored encrypted; recovery codes only as keyed hashes. */
@Injectable()
export class MfaService {
  constructor(private readonly crypto: CryptoService) {}

  generateSecret(): string {
    return generateTotpSecret();
  }

  async enrollment(username: string, secret: string) {
    const url = otpauthUrl('Argus', username, secret);
    return { otpauthUrl: url, qrDataUrl: await toDataURL(url, { margin: 1, width: 220 }), secret };
  }

  /** Returns the matched time step (to be stored for replay protection), or null. */
  verifyTotp(encryptedSecret: string, code: string, lastUsedStep: number | null): number | null {
    return verifyTotp(this.crypto.decrypt(encryptedSecret), code.replace(/\s+/g, ''), { lastUsedStep });
  }

  generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = this.crypto.randomString(10, RECOVERY_ALPHABET);
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    return { codes, hashes: codes.map((c) => this.hashRecoveryCode(c)) };
  }

  /** Returns the remaining hashes if the code matched one, otherwise null. */
  consumeRecoveryCode(hashes: string[], code: string): string[] | null {
    const h = this.hashRecoveryCode(code);
    const idx = hashes.findIndex((x) => this.crypto.safeEqual(x, h));
    return idx === -1 ? null : hashes.filter((_, i) => i !== idx);
  }

  private hashRecoveryCode(code: string): string {
    return this.crypto.hash(`recovery:${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
  }
}
