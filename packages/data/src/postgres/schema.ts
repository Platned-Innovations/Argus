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

export interface Database {
  users: UsersTable;
  teams: TeamsTable;
  teamMembers: TeamMembersTable;
  sessions: SessionsTable;
  auditLogs: AuditLogsTable;
  settings: SettingsTable;
}
