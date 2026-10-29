import { z } from 'zod';

const days = (min: number) => z.number().int().min(min).max(3650);

/** How long Argus keeps historical data. null keeps it forever. Applied daily by the scheduler. */
export const retentionSettingsSchema = z.object({
  /** Finished scan runs, with their logs. */
  scanRunsDays: days(7),
  /** Findings that have been fixed (verified by a later scan). Trends and time-to-fix use them. */
  fixedFindingsDays: days(30).nullable(),
  /** Audit log entries. Kept forever by default; check your compliance obligations before shortening. */
  auditDays: days(90).nullable(),
  /** Security news items that are no longer awaiting analysis or review. */
  intelItemsDays: days(30),
  /** AI usage records (cost accounting). */
  aiUsageDays: days(90),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = { scanRunsDays: 90, fixedFindingsDays: 365, auditDays: null, intelItemsDays: 365, aiUsageDays: 730 };
