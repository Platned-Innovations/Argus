import { createHash } from 'node:crypto';
import { type RepoSchedule } from '@argus/data';
import { CronExpressionParser } from 'cron-parser';

/** Custom schedules may not run more often than this. */
export const MIN_CUSTOM_INTERVAL_MS = 15 * 60_000;

export const DEFAULT_SCHEDULE: RepoSchedule = { preset: 'daily' };

/**
 * Preset schedules are spread deterministically per repository (minute, and an hour between 01:00 and 05:59 UTC)
 * so that hundreds of repositories do not all start scanning at the same moment.
 */
export function cronFor(schedule: RepoSchedule, repoId: string): string | null {
  const h = createHash('sha256').update(repoId).digest();
  const minute = h[0] % 60;
  const hour = 1 + (h[1] % 5);
  switch (schedule.preset) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * 0`;
    case 'custom':
      return schedule.cron ?? null;
    case 'manual':
      return null;
  }
}

export function nextRunAt(schedule: RepoSchedule, repoId: string, from: Date = new Date()): Date | null {
  const cron = cronFor(schedule, repoId);
  if (!cron) return null;
  try {
    return CronExpressionParser.parse(cron, { currentDate: from, tz: 'UTC' }).next().toDate();
  } catch {
    return null;
  }
}

/** Returns an error message for an unusable custom cron expression, or null if it is fine. */
export function validateCron(expr: string): string | null {
  if (expr.trim().split(/\s+/).length !== 5) return 'Use a standard 5-field cron expression (minute hour day month weekday), in UTC.';
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: new Date('2026-01-05T00:00:00Z'), tz: 'UTC' });
    let prev = it.next().toDate().getTime();
    for (let i = 0; i < 20; i++) {
      const next = it.next().toDate().getTime();
      if (next - prev < MIN_CUSTOM_INTERVAL_MS) return 'Scans can run at most every 15 minutes.';
      prev = next;
    }
    return null;
  } catch (err) {
    return `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Comma-separated glob patterns (`*` matches anything) tested case-insensitively against a full repository name. */
export function compilePatterns(patterns: string | null | undefined): (fullName: string) => boolean {
  const regexes = (patterns ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));
  return (fullName) => regexes.some((re) => re.test(fullName));
}
