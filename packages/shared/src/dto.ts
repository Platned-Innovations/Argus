import { type Permission } from './permissions';
import { type Role, type UserStatus } from './roles';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserDto {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  role: Role;
  teamIds: string[];
  status: UserStatus;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeDto extends UserDto {
  permissions: Permission[];
  restrictions: {
    passwordChangeRequired: boolean;
    mfaEnrollmentRequired: boolean;
  };
  passwordPolicy: { minLength: number; requiredClasses: number };
}

export interface TeamDto {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntryDto {
  id: string;
  at: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  outcome: 'success' | 'failure';
  details: Record<string, unknown> | null;
}

export type LoginResponse = { status: 'ok'; user: MeDto } | { status: 'mfa_required'; mfaToken: string };

export interface CreatedUserResponse {
  user: UserDto;
  /** Present only when the server generated a temporary password. Shown once. */
  temporaryPassword?: string;
}

export interface MfaSetupResponse {
  otpauthUrl: string;
  qrDataUrl: string;
  secret: string;
}

export interface MfaEnableResponse {
  recoveryCodes: string[];
}

export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  code?: string;
  issues?: { path: string; message: string }[];
}

export const RESTRICTION_CODES = {
  passwordChangeRequired: 'PASSWORD_CHANGE_REQUIRED',
  mfaEnrollmentRequired: 'MFA_ENROLLMENT_REQUIRED',
} as const;
