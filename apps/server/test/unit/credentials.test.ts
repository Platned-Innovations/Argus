import { describe, expect, it } from 'vitest';
import { noticeDue } from '../../src/credentials/credentials.service';

const now = new Date('2026-10-29T12:00:00Z');
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000 + 3600_000);

describe('credential expiry notices', () => {
  it('sends one notice per threshold reached: 30, 14, 7, 1 days and at expiry', () => {
    expect(noticeDue({ expiresAt: inDays(45), lastNoticeDays: null, archived: false }, now)).toBeNull();
    expect(noticeDue({ expiresAt: inDays(30), lastNoticeDays: null, archived: false }, now)).toBe(30);
    expect(noticeDue({ expiresAt: inDays(20), lastNoticeDays: 30, archived: false }, now)).toBeNull();
    expect(noticeDue({ expiresAt: inDays(13), lastNoticeDays: 30, archived: false }, now)).toBe(14);
    // Skipped thresholds collapse into the most urgent one.
    expect(noticeDue({ expiresAt: inDays(3), lastNoticeDays: null, archived: false }, now)).toBe(7);
    expect(noticeDue({ expiresAt: inDays(0), lastNoticeDays: 7, archived: false }, now)).toBe(1);
    expect(noticeDue({ expiresAt: inDays(-2), lastNoticeDays: 1, archived: false }, now)).toBe(0);
    expect(noticeDue({ expiresAt: inDays(-10), lastNoticeDays: 0, archived: false }, now)).toBeNull();
    expect(noticeDue({ expiresAt: inDays(-10), lastNoticeDays: null, archived: true }, now)).toBeNull();
  });
});
