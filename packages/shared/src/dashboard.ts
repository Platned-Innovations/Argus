import { z } from 'zod';
import { type ScannerName, type Severity } from './findings';

export const DASHBOARD_PERIODS = [30, 90, 180] as const;

export const dashboardQuerySchema = z.object({
  teamId: z.uuid().optional(),
  repoId: z.uuid().optional(),
  days: z.coerce
    .number()
    .int()
    .refine((d) => (DASHBOARD_PERIODS as readonly number[]).includes(d), 'Choose 30, 90 or 180 days.')
    .default(90),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export interface TrendPoint {
  /** YYYY-MM-DD (UTC). */
  date: string;
  bySeverity: Record<Severity, number>;
  total: number;
}

export interface NewVsFixedPoint {
  /** Monday of the week, YYYY-MM-DD (UTC). */
  week: string;
  opened: number;
  fixed: number;
}

export interface RiskyRepoDto {
  repoId: string;
  fullName: string;
  openFindings: number;
  critical: number;
  high: number;
  /** Sum of the risk scores of open findings. */
  riskTotal: number;
}

export interface ExpiringItemDto {
  kind: 'certificate' | 'credential';
  title: string;
  repoId: string | null;
  location: string | null;
  expiresAt: string;
  daysLeft: number;
}

export interface EolExposureDto {
  product: string;
  cycle: string;
  /** End-of-life date, YYYY-MM-DD, or null if only flagged without a date. */
  eol: string | null;
  repos: number;
}

export interface DashboardDto {
  generatedAt: string;
  days: number;
  scope: { teamId: string | null; repoId: string | null };
  open: Record<Severity, number>;
  openTotal: number;
  suppressed: number;
  byScanner: Record<ScannerName, number>;
  /** Open findings per day over the period, reconstructed from first-seen and fixed dates. */
  trend: TrendPoint[];
  newVsFixed: NewVsFixedPoint[];
  /** Mean days from first seen to fixed, for findings fixed in the period; null without samples. */
  mttrDays: Record<Severity, number | null>;
  sla: { resolved: number; onTime: number; compliancePct: number | null; active: number; breached: number };
  topRepos: RiskyRepoDto[];
  expiring: ExpiringItemDto[];
  eol: EolExposureDto[];
}
