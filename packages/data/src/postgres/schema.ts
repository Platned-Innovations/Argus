import { type ColumnType } from 'kysely';

/** jsonb columns: read as parsed JSON, written as a JSON string (node-postgres would mangle JS arrays). */
type Json<T> = ColumnType<T, string, string>;

export interface UsersTable {
  id: string;
  username: string;
  usernameLower: string;
  email: string | null;
  emailLower: string | null;
  displayName: string;
  passwordHash: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  mfaSecretEnc: string | null;
  mfaPendingSecretEnc: string | null;
  mfaRecoveryCodes: Json<string[]>;
  mfaLastUsedStep: number | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamsTable {
  id: string;
  name: string;
  nameLower: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMembersTable {
  teamId: string;
  userId: string;
}

export interface SessionsTable {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
}

export interface AuditLogsTable {
  id: string;
  at: Date;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  outcome: string;
  details: Json<Record<string, unknown> | null> | null;
}

export interface SettingsTable {
  key: string;
  value: Json<unknown>;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface SourcesTable {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  scope: string | null;
  username: string | null;
  tokenEnc: string;
  tokenLast4: string;
  webhookSecretEnc: string;
  autoActivatePattern: string | null;
  defaultTeamId: string | null;
  status: string;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepositoriesTable {
  id: string;
  sourceId: string;
  externalId: string;
  fullName: string;
  name: string;
  htmlUrl: string | null;
  cloneUrl: string;
  defaultBranch: string | null;
  visibility: string;
  language: string | null;
  description: string | null;
  archived: boolean;
  lastPushedAt: Date | null;
  removedAt: Date | null;
  active: boolean;
  teamId: string | null;
  criticality: string;
  branch: string | null;
  schedule: Json<{ preset: string; cron?: string | null }>;
  scanOnPush: boolean;
  jiraProjectKey: string | null;
  notifyEmails: Json<string[]>;
  disabledScanners: Json<string[]>;
  nextScanAt: Date | null;
  lastScanAt: Date | null;
  lastScanStatus: string | null;
  lastScanRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScanRunsTable {
  id: string;
  repoId: string;
  sourceId: string;
  teamId: string | null;
  trigger: string;
  status: string;
  requestedBy: string | null;
  branch: string | null;
  commitSha: string | null;
  attempts: number;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  error: string | null;
  stats: Json<{ files: number; bytes: number; ecosystems: string[]; manifests: string[] } | null> | null;
  log: Json<string[]>;
}

export interface JobsTable {
  id: string;
  type: string;
  payload: Json<Record<string, unknown>>;
  status: string;
  priority: number;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastError: string | null;
  dedupeKey: string | null;
  /** Equals dedupeKey while the job is queued/running, null afterwards; uniquely indexed. */
  activeDedupeKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface LocksTable {
  name: string;
  owner: string;
  expiresAt: Date;
}

export interface FindingsTable {
  id: string;
  repoId: string;
  sourceId: string;
  teamId: string | null;
  scanner: string;
  ruleId: string;
  fingerprint: string;
  title: string;
  description: string | null;
  severity: string;
  riskScore: number;
  riskFactors: Json<unknown[]>;
  status: string;
  path: string | null;
  line: number | null;
  packageEcosystem: string | null;
  packageName: string | null;
  package: Json<Record<string, unknown> | null> | null;
  advisory: Json<Record<string, unknown> | null> | null;
  secret: Json<Record<string, unknown> | null> | null;
  details: Json<Record<string, unknown> | null> | null;
  remediation: string | null;
  suppressionId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  firstRunId: string;
  lastRunId: string;
  fixedAt: Date | null;
}

export interface DependenciesTable {
  id: string;
  repoId: string;
  teamId: string | null;
  ecosystem: string;
  name: string;
  nameLower: string;
  version: string;
  direct: boolean;
  dev: boolean;
  license: string | null;
  manifestPath: string;
  latestVersion: string | null;
  deprecated: string | null;
  vulnerabilities: number;
}

export interface SuppressionsTable {
  id: string;
  repoId: string | null;
  scanner: string | null;
  ruleId: string | null;
  pathPattern: string | null;
  packageName: string | null;
  reason: string;
  expiresAt: Date | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
}

export interface IntelCacheTable {
  key: string;
  value: Json<unknown>;
  fetchedAt: Date;
  expiresAt: Date;
}

export interface Database {
  users: UsersTable;
  teams: TeamsTable;
  teamMembers: TeamMembersTable;
  sessions: SessionsTable;
  auditLogs: AuditLogsTable;
  settings: SettingsTable;
  sources: SourcesTable;
  repositories: RepositoriesTable;
  scanRuns: ScanRunsTable;
  jobs: JobsTable;
  locks: LocksTable;
  findings: FindingsTable;
  dependencies: DependenciesTable;
  suppressions: SuppressionsTable;
  intelCache: IntelCacheTable;
}
