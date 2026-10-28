import { type Role, type UserStatus } from '@argus/shared';

export interface User {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  passwordHash: string;
  role: Role;
  teamIds: string[];
  status: UserStatus;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  /** TOTP secret, encrypted by the application before it reaches the store. */
  mfaSecretEnc: string | null;
  /** Secret generated during enrollment, awaiting confirmation. Encrypted. */
  mfaPendingSecretEnc: string | null;
  /** Keyed hashes of unused recovery codes. */
  mfaRecoveryCodes: string[];
  /** Last accepted TOTP time step; codes at or before it are rejected (replay protection). */
  mfaLastUsedStep: number | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewUser = Pick<User, 'username' | 'email' | 'displayName' | 'passwordHash' | 'role' | 'teamIds' | 'mustChangePassword'>;

export type UserPatch = Partial<Omit<User, 'id' | 'username' | 'createdAt' | 'updatedAt'>>;

export interface UserListFilter {
  search?: string;
  role?: Role;
  status?: UserStatus;
  teamId?: string;
  offset: number;
  limit: number;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamWithCount extends Team {
  memberCount: number;
}

export interface Session {
  id: string;
  userId: string;
  /** Keyed hash of the refresh token; the raw token is never stored. */
  tokenHash: string;
  /** Rotation chain id. Reuse of a rotated token revokes the whole family. */
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
}

export type NewSession = Pick<Session, 'userId' | 'tokenHash' | 'familyId' | 'expiresAt' | 'userAgent' | 'ip'>;

export type AuditOutcome = 'success' | 'failure';

export interface AuditEntry {
  id: string;
  at: Date;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  outcome: AuditOutcome;
  details: Record<string, unknown> | null;
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'at'> & { at?: Date };

export interface AuditFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  from?: Date;
  to?: Date;
  offset: number;
  limit: number;
}

export interface SettingRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
}
