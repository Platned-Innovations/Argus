import { checkPasswordPolicy, hasPermission, permissionsFor, PERMISSIONS } from '@argus/shared';
import { describe, expect, it } from 'vitest';
import { csvCell } from '../../src/audit/audit.controller';
import { AppConfig } from '../../src/config/app-config';
import { CryptoService } from '../../src/core/crypto.service';

const baseEnv = { ARGUS_DB_TYPE: 'postgres', ARGUS_DB_URL: 'postgres://x', ARGUS_MASTER_KEY: 'k'.repeat(40) };

describe('CryptoService', () => {
  const crypto = new CryptoService(AppConfig.fromEnv(baseEnv));

  it('round-trips encryption with a fresh IV each time', () => {
    const a = crypto.encrypt('s3cret');
    const b = crypto.encrypt('s3cret');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(crypto.decrypt(a)).toBe('s3cret');
  });

  it('detects tampering', () => {
    const parts = crypto.encrypt('payload').split('.');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 1;
    parts[3] = ct.toString('base64url');
    expect(() => crypto.decrypt(parts.join('.'))).toThrow();
  });

  it('cannot decrypt with a different master key', () => {
    const other = new CryptoService(AppConfig.fromEnv({ ...baseEnv, ARGUS_MASTER_KEY: 'z'.repeat(40) }));
    expect(() => other.decrypt(crypto.encrypt('x'))).toThrow();
  });

  it('produces deterministic keyed hashes', () => {
    expect(crypto.hash('a')).toBe(crypto.hash('a'));
    expect(crypto.hash('a')).not.toBe(crypto.hash('b'));
  });
});

describe('AppConfig', () => {
  it('fails fast with a readable message', () => {
    expect(() => AppConfig.fromEnv({ ARGUS_DB_TYPE: 'oracle', ARGUS_MASTER_KEY: 'short' })).toThrow(/ARGUS_DB_TYPE[\s\S]*ARGUS_DB_URL[\s\S]*ARGUS_MASTER_KEY/);
  });

  it('treats empty variables as unset', () => {
    expect(AppConfig.fromEnv({ ...baseEnv, ARGUS_ADMIN_PASSWORD: '', ARGUS_PUBLIC_URL: '' }).adminPassword).toBeUndefined();
  });

  it('prefers WEBSITES_PORT (Azure) and infers secure cookies from the public URL', () => {
    const c = AppConfig.fromEnv({ ...baseEnv, PORT: '3000', WEBSITES_PORT: '8081', ARGUS_PUBLIC_URL: 'https://argus.example.com/' });
    expect(c.port).toBe(8081);
    expect(c.cookieSecure).toBe(true);
    expect(c.publicUrl).toBe('https://argus.example.com');
    expect(AppConfig.fromEnv({ ...baseEnv, ARGUS_PUBLIC_URL: 'http://localhost:8080' }).cookieSecure).toBe(false);
  });

  it('scans unless SCAN=false', () => {
    expect(AppConfig.fromEnv(baseEnv).scanEnabled).toBe(true);
    expect(AppConfig.fromEnv({ ...baseEnv, SCAN: 'false' }).scanEnabled).toBe(false);
    expect(() => AppConfig.fromEnv({ ...baseEnv, SCAN: 'no' })).toThrow(/SCAN/);
  });
});

describe('password policy', () => {
  const policy = { minLength: 12, requiredClasses: 3 };
  it('enforces length, character classes and username exclusion', () => {
    expect(checkPasswordPolicy('Short1!', policy)).toHaveLength(1);
    expect(checkPasswordPolicy('alllowercaseletters', policy)[0]).toMatch(/at least 3/);
    expect(checkPasswordPolicy('Alice-Password-2026', policy, { username: 'alice' })).toEqual(['Must not contain the username.']);
    expect(checkPasswordPolicy('Correct-Horse-9', policy)).toEqual([]);
  });
});

describe('permissions', () => {
  it('grants admins everything and viewers nothing that writes', () => {
    expect(permissionsFor('admin')).toEqual([...PERMISSIONS]);
    expect(hasPermission('viewer', 'tickets:write')).toBe(false);
    expect(hasPermission('security_manager', 'users:manage')).toBe(false);
    expect(hasPermission('developer', 'tickets:write')).toBe(true);
  });
});

describe('csvCell', () => {
  it('quotes values and neutralises formulas', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('""');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});
