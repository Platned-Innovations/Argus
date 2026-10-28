import { randomInt } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { checkPasswordPolicy } from '@argus/shared';
import { CryptoService } from '../core/crypto.service';
import { SettingsService } from '../core/settings.service';

// OWASP-recommended argon2id parameters (19 MiB memory, 2 iterations, 1 lane). argon2id is the library default.
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

// Excludes look-alike characters (0/O, 1/l/I) so temporary passwords can be read out loud.
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

@Injectable()
export class PasswordService implements OnModuleInit {
  /** Verified against when the user does not exist, so response time does not reveal valid usernames. */
  private dummyHash = '';

  constructor(
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(this.crypto.randomToken());
  }

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async burnTime(password: string): Promise<void> {
    await this.verify(this.dummyHash, password);
  }

  async policyErrors(password: string, username?: string): Promise<string[]> {
    const s = await this.settings.getSecurity();
    return checkPasswordPolicy(password, { minLength: s.passwordMinLength, requiredClasses: s.passwordRequiredClasses }, { username });
  }

  /** A random password that satisfies any policy the settings allow (all four classes, >= 20 chars). */
  async generateTemporary(): Promise<string> {
    const s = await this.settings.getSecurity();
    const length = Math.max(20, s.passwordMinLength);
    const all = LOWER + UPPER + DIGITS + SYMBOLS;
    const required = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => this.crypto.randomString(1, set));
    const chars = [...required, ...this.crypto.randomString(length - required.length, all)];
    // Fisher-Yates shuffle so the required characters are not always first.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }
}
