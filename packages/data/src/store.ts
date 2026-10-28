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
  /** Deletes the team and removes it from every member. */
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

export type DataStoreKind = 'postgres' | 'mongodb';

export interface DataStore {
  readonly kind: DataStoreKind;
  readonly users: UserRepo;
  readonly teams: TeamRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
  readonly settings: SettingsRepo;
  /** Applies pending schema migrations / index bootstrap. Safe to call concurrently from several instances. */
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
