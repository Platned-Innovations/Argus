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
import {
  type CacheEntry,
  type Dependency,
  type DependencyListFilter,
  type DependencySearchFilter,
  type Finding,
  type FindingListFilter,
  type FindingSummaryRecord,
  type NewSuppression,
  type ObservedFinding,
  type ReconcileContext,
  type ReconcileResult,
  type Suppression,
} from './findings-models';
import {
  type Channel,
  type ChannelPatch,
  type NewChannel,
  type NewNotificationRule,
  type NewTicket,
  type NewTicketEvent,
  type NotificationRule,
  type Ticket,
  type TicketEvent,
  type TicketListFilter,
  type TicketPatch,
  type TicketSummaryRecord,
} from './tickets-models';

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
  setTeamForRepo(repoId: string, teamId: string | null): Promise<void>;
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

export interface FindingRepo {
  /**
   * Applies a scan result: inserts new findings, refreshes ones seen again (re-opening fixed ones),
   * and marks open/suppressed findings of the completed scanners that were not seen as fixed.
   */
  reconcile(ctx: ReconcileContext, observed: ObservedFinding[]): Promise<ReconcileResult>;
  findById(id: string): Promise<Finding | null>;
  /** Highest risk first. */
  list(filter: FindingListFilter): Promise<Page<Finding>>;
  update(id: string, patch: Partial<Pick<Finding, 'status' | 'suppressionId'>>): Promise<Finding | null>;
  summary(filter: { repoId?: string; visibleTeamIds?: string[]; fixedSince: Date }): Promise<FindingSummaryRecord>;
  setTeamForRepo(repoId: string, teamId: string | null): Promise<void>;
  /** Links findings to the ticket that tracks them. */
  setTicket(ids: string[], ticketId: string): Promise<void>;
  /** Every finding of a repository (all statuses), for ticket synchronisation. */
  listAllForRepo(repoId: string): Promise<Finding[]>;
}

export interface DependencyRepo {
  /** Replaces the repository's dependency inventory with the result of the latest scan. */
  replaceForRepo(repoId: string, deps: Dependency[]): Promise<void>;
  listForRepo(repoId: string, filter: DependencyListFilter): Promise<Page<Dependency>>;
  /** Every repository that uses a package, newest inventory only. */
  search(filter: DependencySearchFilter): Promise<Dependency[]>;
  setTeamForRepo(repoId: string, teamId: string | null): Promise<void>;
}

export interface SuppressionRepo {
  create(input: NewSuppression): Promise<Suppression>;
  findById(id: string): Promise<Suppression | null>;
  /** All suppressions, or those for one repository plus global ones. */
  list(filter?: { repoId?: string }): Promise<Suppression[]>;
  /** Unexpired suppressions that apply to a repository (its own and global ones). */
  listApplicable(repoId: string, now: Date): Promise<Suppression[]>;
  delete(id: string): Promise<boolean>;
}

/** Key-value cache for threat-intelligence lookups (advisories, KEV, EPSS, end-of-life data, registry metadata). */
export interface CacheRepo {
  get<T = unknown>(key: string): Promise<CacheEntry<T> | null>;
  getMany<T = unknown>(keys: string[]): Promise<Map<string, CacheEntry<T>>>;
  set<T = unknown>(key: string, value: T, ttlMs: number): Promise<void>;
  deleteExpired(before: Date): Promise<number>;
}

export interface TicketRepo {
  create(input: NewTicket): Promise<Ticket>;
  findById(id: string): Promise<Ticket | null>;
  /** Every ticket of a repository, any status (one per group key). */
  listForRepo(repoId: string): Promise<Ticket[]>;
  update(id: string, patch: TicketPatch): Promise<Ticket | null>;
  /** Highest risk first. */
  list(filter: TicketListFilter): Promise<Page<Ticket>>;
  summary(filter: { visibleTeamIds?: string[]; userId: string; now: Date }): Promise<TicketSummaryRecord>;
  /** Active tickets past their due date that have not been flagged yet. */
  findNewlyOverdue(now: Date, limit: number): Promise<Ticket[]>;
  /** Tickets linked to Jira that are not closed. */
  listJiraLinked(limit: number): Promise<Ticket[]>;
  setTeamForRepo(repoId: string, teamId: string | null): Promise<void>;
  addEvent(event: NewTicketEvent): Promise<TicketEvent>;
  /** Oldest first. */
  listEvents(ticketId: string): Promise<TicketEvent[]>;
}

export interface CounterRepo {
  /** Atomically increments and returns the named counter (first value is 1). */
  next(name: string): Promise<number>;
}

export interface ChannelRepo {
  create(input: NewChannel): Promise<Channel>;
  findById(id: string): Promise<Channel | null>;
  list(): Promise<Channel[]>;
  update(id: string, patch: ChannelPatch): Promise<Channel | null>;
  delete(id: string): Promise<boolean>;
}

export interface NotificationRuleRepo {
  create(input: NewNotificationRule): Promise<NotificationRule>;
  findById(id: string): Promise<NotificationRule | null>;
  list(): Promise<NotificationRule[]>;
  update(id: string, patch: Partial<NewNotificationRule>): Promise<NotificationRule | null>;
  delete(id: string): Promise<boolean>;
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
  readonly findings: FindingRepo;
  readonly dependencies: DependencyRepo;
  readonly suppressions: SuppressionRepo;
  readonly cache: CacheRepo;
  readonly tickets: TicketRepo;
  readonly counters: CounterRepo;
  readonly channels: ChannelRepo;
  readonly notificationRules: NotificationRuleRepo;
  /** Applies pending schema migrations / index bootstrap. Safe to call concurrently from several instances. */
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
