import { z } from 'zod';
import { SCANNERS, type ScannerName, type Severity } from './findings';
import { pageFields } from './schemas';

export const PROVIDERS = ['github', 'bitbucket_cloud', 'bitbucket_server'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  github: 'GitHub',
  bitbucket_cloud: 'Bitbucket Cloud',
  bitbucket_server: 'Bitbucket Data Center / Server',
};

export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const SCHEDULE_PRESETS = ['hourly', 'daily', 'weekly', 'manual', 'custom'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

export const SCHEDULE_LABELS: Record<SchedulePreset, string> = {
  hourly: 'Every hour',
  daily: 'Every day',
  weekly: 'Every week',
  manual: 'Manual only',
  custom: 'Custom (cron)',
};

export const SCAN_TRIGGERS = ['schedule', 'manual', 'push', 'activation'] as const;
export type ScanTrigger = (typeof SCAN_TRIGGERS)[number];

export const SCAN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SOURCE_STATUSES = ['pending', 'ok', 'error'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const scheduleSchema = z
  .object({
    preset: z.enum(SCHEDULE_PRESETS),
    cron: z.string().trim().max(100).nullable().optional(),
  })
  .refine((s) => s.preset !== 'custom' || !!s.cron, { message: 'A cron expression is required for a custom schedule.', path: ['cron'] });
export type Schedule = z.infer<typeof scheduleSchema>;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const sourceFields = {
  name: z.string().trim().min(2).max(80),
  provider: z.enum(PROVIDERS),
  /** API base URL. Empty for github.com / bitbucket.org; required for GitHub Enterprise Server and Bitbucket Data Center. */
  baseUrl: z.url().max(500).nullable().optional(),
  /** GitHub organisation, Bitbucket Cloud workspace or Bitbucket Data Center project key. */
  scope: optionalText(200),
  /** Bitbucket username / Atlassian account email for basic auth; leave empty for bearer-style tokens. */
  username: optionalText(200),
  token: z.string().trim().min(1).max(4096),
  /** Comma-separated glob patterns (e.g. "payments/*, *-api") matched against the full name of newly discovered repositories. */
  autoActivatePattern: optionalText(500),
  defaultTeamId: z.uuid().nullable().optional(),
};

export const sourceCreateSchema = z.object(sourceFields).superRefine((s, ctx) => {
  if (s.provider === 'bitbucket_server' && !s.baseUrl) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'The server URL is required for Bitbucket Data Center.' });
  if (s.provider === 'bitbucket_cloud' && !s.scope) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'The workspace is required for Bitbucket Cloud.' });
});
export type SourceCreateInput = z.infer<typeof sourceCreateSchema>;

/** Token is optional on update: omit it to keep the stored credential. */
export const sourceUpdateSchema = z.object(sourceFields).omit({ provider: true }).partial();
export type SourceUpdateInput = z.infer<typeof sourceUpdateSchema>;

export const sourceTestSchema = z.object({
  provider: sourceFields.provider,
  baseUrl: sourceFields.baseUrl,
  scope: sourceFields.scope,
  username: sourceFields.username,
  token: sourceFields.token,
});
export type SourceTestInput = z.infer<typeof sourceTestSchema>;

export const repoUpdateSchema = z
  .object({
    active: z.boolean(),
    teamId: z.uuid().nullable(),
    criticality: z.enum(CRITICALITIES),
    /** Branch to scan; null means the repository's default branch. */
    branch: z.string().trim().min(1).max(250).regex(/^[^\s~^:?*[\\]+$/, 'Not a valid branch name.').nullable(),
    schedule: scheduleSchema,
    scanOnPush: z.boolean(),
    jiraProjectKey: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,49}$/, 'Use the Jira project key, e.g. PAY.').nullable(),
    notifyEmails: z.array(z.email()).max(20),
    /** Scanners turned off for this repository. */
    disabledScanners: z.array(z.enum(SCANNERS)).max(SCANNERS.length),
    /** false excludes the repository from every AI feature. */
    aiEnabled: z.boolean(),
  })
  .partial();
export type RepoUpdateInput = z.infer<typeof repoUpdateSchema>;

export const repoBulkUpdateSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
  patch: repoUpdateSchema.pick({ active: true, teamId: true, criticality: true, schedule: true, scanOnPush: true, disabledScanners: true, aiEnabled: true }),
});
export type RepoBulkUpdateInput = z.infer<typeof repoBulkUpdateSchema>;

const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listReposQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  sourceId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  active: boolParam.optional(),
  ...pageFields,
});
export type ListReposQuery = z.infer<typeof listReposQuerySchema>;

export const listScanRunsQuerySchema = z.object({
  repoId: z.uuid().optional(),
  status: z.enum(SCAN_STATUSES).optional(),
  ...pageFields,
});
export type ListScanRunsQuery = z.infer<typeof listScanRunsQuerySchema>;

export interface SourceDto {
  id: string;
  name: string;
  provider: Provider;
  baseUrl: string | null;
  scope: string | null;
  username: string | null;
  /** Masked hint of the stored token, e.g. "••••3f9a". The token itself is never returned. */
  tokenHint: string;
  autoActivatePattern: string | null;
  defaultTeamId: string | null;
  status: SourceStatus;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  repoCount: number;
  activeRepoCount: number;
  /** Path of the push webhook endpoint; prefix with the public URL. */
  webhookPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceWithSecretDto {
  source: SourceDto;
  /** Shown once, at creation or rotation. */
  webhookSecret: string;
}

export interface SourceTestResult {
  ok: boolean;
  /** Who the token authenticates as, when the provider says. */
  identity: string | null;
  /** Number of repositories visible on the first page. */
  visibleRepos: number | null;
  message: string | null;
}

export interface RepositoryDto {
  id: string;
  sourceId: string;
  provider: Provider;
  fullName: string;
  name: string;
  htmlUrl: string | null;
  defaultBranch: string | null;
  visibility: 'public' | 'private' | 'internal';
  language: string | null;
  description: string | null;
  archived: boolean;
  removed: boolean;
  lastPushedAt: string | null;
  active: boolean;
  teamId: string | null;
  criticality: Criticality;
  branch: string | null;
  schedule: Schedule;
  scanOnPush: boolean;
  jiraProjectKey: string | null;
  notifyEmails: string[];
  disabledScanners: ScannerName[];
  aiEnabled: boolean;
  nextScanAt: string | null;
  lastScanAt: string | null;
  lastScanStatus: ScanStatus | null;
  lastScanRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScannerRunResult {
  scanner: ScannerName;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  findings: number;
  durationMs: number;
  message: string | null;
}

export interface ScanStats {
  files: number;
  bytes: number;
  /** Ecosystems detected from manifest files, e.g. ["npm", "nuget"]. */
  ecosystems: string[];
  manifests: string[];
  dependencies?: number;
  scanners?: ScannerRunResult[];
  findings?: { open: Record<Severity, number>; new: number; fixed: number; reopened: number };
}

export interface ScanRunDto {
  id: string;
  repoId: string;
  repoFullName: string | null;
  trigger: ScanTrigger;
  status: ScanStatus;
  requestedBy: string | null;
  branch: string | null;
  commitSha: string | null;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  stats: ScanStats | null;
  log?: string[];
}
