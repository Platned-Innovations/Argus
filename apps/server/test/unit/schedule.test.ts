import { describe, expect, it } from 'vitest';
import { Redactor } from '../../src/common/redact';
import { retryDelayMs } from '../../src/jobs/job-runner.service';
import { compilePatterns, cronFor, nextRunAt, validateCron } from '../../src/scans/schedule';

describe('schedules', () => {
  const id = '6f9619ff-8b86-4011-b42d-00c04fc964ff';

  it('spreads presets deterministically per repository, within 01:00-05:59 UTC', () => {
    const daily = cronFor({ preset: 'daily' }, id)!;
    expect(cronFor({ preset: 'daily' }, id)).toBe(daily);
    const [minute, hour] = daily.split(' ').map(Number);
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThan(60);
    expect(hour).toBeGreaterThanOrEqual(1);
    expect(hour).toBeLessThanOrEqual(5);
    expect(cronFor({ preset: 'weekly' }, id)).toMatch(/ \* \* 0$/);
    expect(cronFor({ preset: 'hourly' }, id)).toMatch(/^\d+ \* \* \* \*$/);
    expect(cronFor({ preset: 'manual' }, id)).toBeNull();
    const spread = new Set(Array.from({ length: 50 }, (_, i) => cronFor({ preset: 'daily' }, `repo-${i}`)));
    expect(spread.size).toBeGreaterThan(30);
  });

  it('computes the next run in UTC', () => {
    const from = new Date('2026-10-29T10:00:00Z');
    const next = nextRunAt({ preset: 'custom', cron: '30 12 * * *' }, id, from)!;
    expect(next.toISOString()).toBe('2026-10-29T12:30:00.000Z');
    const hourly = nextRunAt({ preset: 'hourly' }, id, from)!;
    expect(hourly.getTime() - from.getTime()).toBeLessThanOrEqual(3600_000);
    expect(nextRunAt({ preset: 'manual' }, id, from)).toBeNull();
  });

  it('validates custom cron expressions and enforces a 15-minute minimum interval', () => {
    expect(validateCron('0 2 * * 1-5')).toBeNull();
    expect(validateCron('*/15 * * * *')).toBeNull();
    expect(validateCron('*/5 * * * *')).toMatch(/15 minutes/);
    expect(validateCron('* * * * *')).toMatch(/15 minutes/);
    expect(validateCron('0 2 * *')).toMatch(/5-field/);
    expect(validateCron('99 2 * * *')).toMatch(/Invalid cron/);
  });

  it('matches auto-activation glob patterns case-insensitively', () => {
    const m = compilePatterns('payments/*, *-API , platform/core');
    expect(m('Payments/ledger')).toBe(true);
    expect(m('acme/orders-api')).toBe(true);
    expect(m('platform/core')).toBe(true);
    expect(m('platform/core-legacy')).toBe(false);
    expect(compilePatterns(null)('anything')).toBe(false);
    expect(compilePatterns('a.b')('axb')).toBe(false);
  });
});

describe('job retry backoff', () => {
  it('grows exponentially and is capped', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(240_000);
    expect(retryDelayMs(10)).toBe(3600_000);
  });
});

describe('Redactor', () => {
  it('removes known secrets, URL credentials and authorization headers', () => {
    const r = new Redactor(['ghp_abcdef123456', 'abc', null]);
    expect(r.redact('token ghp_abcdef123456 used')).toBe('token [redacted] used');
    expect(r.redact('fatal: https://user:pass@github.com/x.git failed')).toBe('fatal: https://[redacted]@github.com/x.git failed');
    expect(r.redact('Authorization: Bearer eyJhbGciOi')).toBe('Authorization: Bearer [redacted]');
    expect(r.redact('abc stays because too short to be a secret')).toContain('abc');
  });
});
