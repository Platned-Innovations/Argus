import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config';

const ENVELOPE_VERSION = 'v1';

function deriveKey(masterKey: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(masterKey, 'utf8'), 'argus', `argus/${purpose}`, 32));
}

/**
 * All application cryptography keyed from ARGUS_MASTER_KEY.
 * Independent sub-keys are derived per purpose with HKDF so no key is reused across algorithms.
 */
@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly hashKey: Buffer;
  readonly jwtSecret: string;

  constructor(config: AppConfig) {
    this.encryptionKey = deriveKey(config.masterKey, 'encryption/v1');
    this.hashKey = deriveKey(config.masterKey, 'hash/v1');
    this.jwtSecret = deriveKey(config.masterKey, 'jwt/v1').toString('base64');
  }

  /** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url segments. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [ENVELOPE_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(envelope: string): string {
    const [version, iv, tag, ciphertext] = envelope.split('.');
    if (version !== ENVELOPE_VERSION || !iv || !tag || ciphertext === undefined) throw new Error('Unsupported ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Keyed hash (HMAC-SHA256) for values that must be looked up but never stored raw, e.g. refresh tokens. */
  hash(value: string): string {
    return createHmac('sha256', this.hashKey).update(value, 'utf8').digest('base64url');
  }

  safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Uniformly random string over an alphabet (crypto.randomInt avoids modulo bias). */
  randomString(length: number, alphabet: string): string {
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
    return out;
  }
}
