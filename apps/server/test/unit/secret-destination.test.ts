import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertSecretReentered, urlOrigin } from '../../src/common/secret-destination';

describe('stored secret destinations', () => {
  it('compares origins, not paths or letter case', () => {
    expect(urlOrigin('https://Jira.Acme.com/path/')).toBe('https://jira.acme.com');
    expect(urlOrigin('https://jira.acme.com:8443')).toBe('https://jira.acme.com:8443');
    expect(urlOrigin(null)).toBeNull();
  });

  it('keeps a stored secret only for the destination it was entered for', () => {
    const opts = { hadSecret: true, secretProvided: false, what: 'token' };
    expect(assertSecretReentered('https://api.github.com', 'https://api.github.com', opts)).toBeNull();
    expect(() => assertSecretReentered('https://api.github.com', 'https://collector.attacker.test', opts)).toThrow(BadRequestException);
    // null is the provider's own default address, so moving away from it is a change too.
    expect(() => assertSecretReentered(null, 'https://collector.attacker.test', opts)).toThrow(BadRequestException);
  });

  it('allows the change when the secret is entered again, or when there is none', () => {
    expect(assertSecretReentered('https://a.test', 'https://b.test', { hadSecret: true, secretProvided: true, what: 'token' })).toEqual({ from: 'https://a.test', to: 'https://b.test' });
    expect(assertSecretReentered('https://a.test', 'https://b.test', { hadSecret: false, secretProvided: false, what: 'token' })).toEqual({ from: 'https://a.test', to: 'https://b.test' });
  });
});
