import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUrl, verifyTotp } from '../../src/auth/totp';

// RFC 4226 Appendix D / RFC 6238 Appendix B shared secret.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('totp', () => {
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('matches RFC 6238 SHA-1 vectors (last 6 digits)', () => {
    const b32 = base32Encode(RFC_SECRET);
    expect(verifyTotp(b32, '287082', { nowMs: 59_000, window: 0 })).toBe(1);
    expect(verifyTotp(b32, '081804', { nowMs: 1_111_111_109_000, window: 0 })).not.toBeNull();
    expect(verifyTotp(b32, '005924', { nowMs: 1_234_567_890_000, window: 0 })).not.toBeNull();
  });

  it('round-trips base32', () => {
    for (const len of [0, 1, 5, 10, 20, 33]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37) & 255));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it('accepts adjacent steps within the window and rejects others', () => {
    const b32 = base32Encode(RFC_SECRET);
    const now = 30_000 * 1000;
    const prev = hotp(RFC_SECRET, 999);
    expect(verifyTotp(b32, prev, { nowMs: now })).toBe(999);
    expect(verifyTotp(b32, hotp(RFC_SECRET, 997), { nowMs: now })).toBeNull();
  });

  it('rejects replayed steps', () => {
    const b32 = base32Encode(RFC_SECRET);
    const now = 30_000 * 1000;
    const code = hotp(RFC_SECRET, 1000);
    expect(verifyTotp(b32, code, { nowMs: now, lastUsedStep: 999 })).toBe(1000);
    expect(verifyTotp(b32, code, { nowMs: now, lastUsedStep: 1000 })).toBeNull();
  });

  it('rejects malformed codes', () => {
    const b32 = base32Encode(RFC_SECRET);
    expect(verifyTotp(b32, '12345')).toBeNull();
    expect(verifyTotp(b32, 'abcdef')).toBeNull();
  });

  it('builds an otpauth URL', () => {
    const url = new URL(otpauthUrl('Argus', 'alice', 'ABC'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.searchParams.get('secret')).toBe('ABC');
    expect(url.searchParams.get('issuer')).toBe('Argus');
  });
});
