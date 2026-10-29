import { z } from 'zod';
import { type AiProvider } from './ai';
import { ECOSYSTEMS, type Ecosystem, type Severity, SEVERITIES } from './findings';
import { pageFields } from './schemas';

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const https = z.url().refine((u) => u.startsWith('https://') || LOOPBACK.test(u), 'Must be an https:// URL.');

// ---------------------------------------------------------------- news sources

export const intelSourceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** RSS 2.0 or Atom feed. */
  url: https,
  enabled: z.boolean().default(true),
  /** How often the feed is fetched. */
  intervalMinutes: z.number().int().min(15).max(10_080).default(360),
});
export type IntelSourceInput = z.infer<typeof intelSourceSchema>;

export interface IntelSourceDto extends IntelSourceInput {
  id: string;
  lastFetchedAt: string | null;
  lastError: string | null;
  /** New items found at the last fetch. */
  lastNewItems: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Feeds offered on a new installation, switched off until an administrator enables them. */
export const DEFAULT_INTEL_SOURCES: IntelSourceInput[] = [
  { name: 'GitHub Security Lab / GitHub Blog (security)', url: 'https://github.blog/security/feed/', enabled: false, intervalMinutes: 360 },
  { name: 'Node.js vulnerability announcements', url: 'https://nodejs.org/en/feed/vulnerability.xml', enabled: false, intervalMinutes: 360 },
  { name: 'Microsoft Security Response Center (update guide)', url: 'https://api.msrc.microsoft.com/update-guide/rss', enabled: false, intervalMinutes: 360 },
  { name: '.NET Blog', url: 'https://devblogs.microsoft.com/dotnet/feed/', enabled: false, intervalMinutes: 720 },
];

// ---------------------------------------------------------------- news items and review

export const INTEL_ITEM_STATUSES = ['new', 'no_match', 'review', 'approved', 'rejected', 'error'] as const;
export type IntelItemStatus = (typeof INTEL_ITEM_STATUSES)[number];

export const INTEL_ITEM_STATUS_LABELS: Record<IntelItemStatus, string> = {
  new: 'Not analysed',
  no_match: 'No npm/NuGet impact',
  review: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
  error: 'Analysis failed',
};

const cve = z.string().trim().regex(/^CVE-\d{4}-\d{4,}$/, 'Use the CVE id, e.g. CVE-2026-12345.');

/** An advisory proposed by AI extraction or entered by a person. `affectedRange` is an npm-style range, e.g. "<4.17.21" or ">=2.0.0 <2.3.1". */
export const advisoryInputSchema = z.object({
  ecosystem: z.enum(ECOSYSTEMS),
  packageName: z.string().trim().min(1).max(214),
  affectedRange: z.string().trim().min(1).max(200),
  fixedVersion: z.string().trim().max(100).nullable(),
  severity: z.enum(SEVERITIES),
  cvssScore: z.number().min(0).max(10).nullable().default(null),
  cveIds: z.array(cve).max(20).default([]),
  title: z.string().trim().min(3).max(300),
  summary: z.string().trim().max(4000).default(''),
  references: z.array(https).max(10).default([]),
});
export type AdvisoryInput = z.infer<typeof advisoryInputSchema>;

/** AI output for one news item. */
export const advisoryExtractionOutputSchema = z.object({
  /** Whether the item announces a vulnerability in an npm or NuGet package. */
  relevant: z.boolean(),
  advisories: z
    .array(
      z.object({
        ecosystem: z.enum(ECOSYSTEMS),
        packageName: z.string().trim().min(1).max(214),
        affectedRange: z.string().trim().min(1).max(200),
        fixedVersion: z.string().trim().max(100).nullable(),
        severity: z.enum(SEVERITIES),
        cveIds: z.array(z.string().trim().max(30)).max(20),
        title: z.string().trim().min(3).max(300),
        summary: z.string().trim().max(4000),
      }),
    )
    .max(10),
  rationale: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});
export type AdvisoryExtractionOutput = z.infer<typeof advisoryExtractionOutputSchema>;

export interface IntelExtractionDto {
  provider: AiProvider;
  model: string;
  confidence: number;
  rationale: string;
  at: string;
}

export interface IntelItemDto {
  id: string;
  sourceId: string;
  sourceName: string | null;
  title: string;
  link: string | null;
  publishedAt: string | null;
  summary: string;
  status: IntelItemStatus;
  /** Proposed advisories (from AI extraction), for review. */
  candidates: AdvisoryInput[];
  extraction: IntelExtractionDto | null;
  error: string | null;
  advisoryIds: string[];
  reviewedByName: string | null;
  reviewedAt: string | null;
  fetchedAt: string;
}

export const listIntelItemsQuerySchema = z.object({
  status: z.enum(INTEL_ITEM_STATUSES).optional(),
  sourceId: z.uuid().optional(),
  search: z.string().trim().max(200).optional(),
  ...pageFields,
});
export type ListIntelItemsQuery = z.infer<typeof listIntelItemsQuerySchema>;

export const intelReviewSchema = z.discriminatedUnion('action', [
  /** Approve the (possibly edited) advisories; each becomes an Argus advisory and is matched straight away. */
  z.object({ action: z.literal('approve'), advisories: z.array(advisoryInputSchema).min(1).max(10) }),
  z.object({ action: z.literal('reject'), note: z.string().trim().max(500).optional() }),
]);
export type IntelReviewInput = z.infer<typeof intelReviewSchema>;

// ---------------------------------------------------------------- Argus advisories

export const ADVISORY_SOURCES = ['news', 'manual'] as const;
export type AdvisorySource = (typeof ADVISORY_SOURCES)[number];

export interface AdvisoryDto extends AdvisoryInput {
  id: string;
  /** e.g. ARGUS-2026-0001 */
  key: string;
  source: AdvisorySource;
  sourceItemId: string | null;
  withdrawn: boolean;
  /** AI extracted it and it was approved automatically (above the confidence threshold). */
  autoApproved: boolean;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Repositories whose current inventory matches. */
  affectedRepos: number;
}

export const listAdvisoriesQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  withdrawn: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  ...pageFields,
});

export const advisoryUpdateSchema = z.object({ withdrawn: z.boolean() });

// ---------------------------------------------------------------- settings and overview

export const intelSettingsSchema = z.object({
  /** Fetch enabled news sources on their schedule. */
  crawlEnabled: z.boolean(),
  /** Approve AI-extracted advisories without review when the model's confidence is at least the threshold. */
  autoApprove: z.boolean(),
  autoApproveMinConfidence: z.number().min(0.5).max(1),
  /** How often stored dependency inventories are re-checked against OSV for newly published advisories. */
  rematchIntervalHours: z.number().int().min(1).max(168),
});
export type IntelSettings = z.infer<typeof intelSettingsSchema>;

export const DEFAULT_INTEL_SETTINGS: IntelSettings = { crawlEnabled: true, autoApprove: false, autoApproveMinConfidence: 0.9, rematchIntervalHours: 24 };

/** A newly published advisory that matched repositories between scans. */
export interface EmergingThreatDto {
  advisoryId: string;
  /** Argus advisory id, when the advisory is one of Argus's own. */
  argusAdvisoryId: string | null;
  title: string;
  severity: Severity;
  ecosystem: Ecosystem;
  packageName: string;
  repos: number;
  findings: number;
  at: string;
}

export interface RematchRunDto {
  at: string;
  trigger: 'schedule' | 'advisory' | 'manual';
  packages: number;
  repos: number;
  newFindings: number;
  error: string | null;
}

export interface IntelOverviewDto {
  items: Record<IntelItemStatus, number>;
  sources: { total: number; enabled: number; failing: number };
  advisories: { active: number };
  lastRematch: RematchRunDto | null;
  emerging: EmergingThreatDto[];
  aiExtraction: boolean;
}
