import {
  type AuditEntry,
  type AuditFilter,
  type NewAuditEntry,
  type NewSession,
  type NewUser,
  type Page,
  type Session,
  type SettingRecord,
  type Team,
  type TeamWithCount,
  type User,
  type UserListFilter,
  type UserPatch,
} from './models';
import {
  type DiscoveredRepo,
  type DiscoveryDefaults,
  type Job,
  type NewJob,
  type NewScanRun,
  type NewSource,
  type Repository,
  type RepositoryListFilter,
  type RepositoryPatch,
  type ScanRun,
  type ScanRunListFilter,
  type ScanRunPatch,
  type Source,
  type SourcePatch,
  type SourceWithCounts,
  type SyncResult,
} from './scanning-models';

export interface UserRepo {
  create(input: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  /** Case-insensitive. */
  findByUsername(username: string): Promise<User | null>;
  /** Case-insensitive. */
  findByEmail(email: string): Promise<User | null>;
  update(id: string, patch: UserPatch): Promise<User | null>;
  /** Atomically increments the failed login counter and returns the new value. */
  incrementFailedLogins(id: string): Promise<number>;
  list(filter: UserListFilter): Promise<Page<User>>;
  count(): Promise<number>;
}

export interface TeamRepo {
  create(input: { name: string; description: string | null }): Promise<Team>;
  findById(id: string): Promise<Team | null>;
  findByIds(ids: string[]): Promise<Team[]>;
  update(id: string, patch: { name?: string; description?: string | null }): Promise<Team | null>;
  /** Deletes the team, removes it from every member and unassigns its repositories. */
  delete(id: string): Promise<boolean>;
  list(): Promise<TeamWithCount[]>;
}

export interface SessionRepo {
  create(input: NewSession): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  /** Revokes the session only if it is still active. Returns true when this call revoked it. */
  revokeIfActive(id: string): Promise<boolean>;
  revokeFamily(familyId: string): Promise<number>;
  revokeAllForUser(userId: string, exceptId?: string): Promise<number>;
  deleteExpired(before: Date): Promise<number>;
}

export interface AuditRepo {
  append(entry: NewAuditEntry): Promise<AuditEntry>;
  list(filter: AuditFilter): Promise<Page<AuditEntry>>;
}

export interface SettingsRepo {
  get<T = unknown>(key: string): Promise<SettingRecord<T> | null>;
  set<T = unknown>(key: string, value: T, updatedBy: string | null): Promise<SettingRecord<T>>;
}

export interface SourceRepo {
  create(input: NewSource): Promise<Source>;
  findById(id: string): Promise<Source | null>;
  list(): Promise<SourceWithCounts[]>;
  update(id: string, patch: SourcePatch): Promise<Source | null>;
  /** Deletes the source together with its repositories and their scan runs. */
  delete(id: string): Promise<boolean>;
}

export interface RepositoryRepo {
  /**
   * Reconciles a source's repository list: inserts new repositories (applying the defaults),
   * refreshes provider metadata of known ones, and marks missing ones as removed (deactivating them).
   */
  syncFromSource(sourceId: string, discovered: DiscoveredRepo[], defaults: DiscoveryDefaults): Promise<SyncResult>;
  findById(id: string): Promise<Repository | null>;
  findByExternalId(sourceId: string, externalId: string): Promise<Repository | null>;
  findByIds(ids: string[]): Promise<Repository[]>;
  list(filter: RepositoryListFilter): Promise<Page<Repository>>;
  update(id: string, patch: RepositoryPatch): Promise<Repository | null>;
  /** Active, not removed repositories whose nextScanAt is at or before `now`, oldest first. */
  findDue(now: Date, limit: number): Promise<Repository[]>;
}

export interface ScanRunRepo {
  create(input: NewScanRun): Promise<ScanRun>;
  findById(id: string): Promise<ScanRun | null>;
  update(id: string, patch: ScanRunPatch): Promise<ScanRun | null>;
  delete(id: string): Promise<boolean>;
  /** The queued or running run for a repository, if any. */
  findActiveForRepo(repoId: string): Promise<ScanRun | null>;
  /** Newest first. */
  list(filter: ScanRunListFilter): Promise<Page<ScanRun>>;
  deleteFinishedBefore(before: Date): Promise<number>;
}

export interface JobRepo {
  /** Returns null when another queued or running job already holds the dedupe key. */
  enqueue(input: NewJob): Promise<Job | null>;
  /**
   * Atomically leases the next runnable job of the given types: a queued job whose runAt has passed,
   * or a running job whose lease expired because its worker died. Increments attempts.
   */
  claim(types: string[], workerId: string, leaseMs: number): Promise<Job | null>;
  extendLease(id: string, workerId: string, leaseMs: number): Promise<boolean>;
  complete(id: string, workerId: string): Promise<boolean>;
  /** With retryAt the job is re-queued (keeping its dedupe key); otherwise it is marked failed. */
  fail(id: string, workerId: string, error: string, retryAt: Date | null): Promise<boolean>;
  findById(id: string): Promise<Job | null>;
  deleteFinishedBefore(before: Date): Promise<number>;
}

export interface LockRepo {
  /** Acquires or renews a named lease. Returns false while another owner holds an unexpired lease. */
  acquire(name: string, owner: string, ttlMs: number): Promise<boolean>;
  release(name: string, owner: string): Promise<void>;
}

export type DataStoreKind = 'postgres' | 'mongodb';

export interface DataStore {
  readonly kind: DataStoreKind;
  readonly users: UserRepo;
  readonly teams: TeamRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
  readonly settings: SettingsRepo;
  readonly sources: SourceRepo;
  readonly repositories: RepositoryRepo;
  readonly scanRuns: ScanRunRepo;
  readonly jobs: JobRepo;
  readonly locks: LockRepo;
  /** Applies pending schema migrations / index bootstrap. Safe to call concurrently from several instances. */
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
