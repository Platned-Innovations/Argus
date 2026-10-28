import { type User } from '@argus/data';
import { type MeDto, permissionsFor, type SecuritySettings, type UserDto } from '@argus/shared';

export function toUserDto(u: User): UserDto {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    teamIds: u.teamIds,
    status: u.status,
    mfaEnabled: u.mfaEnabled,
    mustChangePassword: u.mustChangePassword,
    lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil.toISOString() : null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export function toMeDto(u: User, security: SecuritySettings): MeDto {
  return {
    ...toUserDto(u),
    permissions: permissionsFor(u.role),
    restrictions: {
      passwordChangeRequired: u.mustChangePassword,
      mfaEnrollmentRequired: security.mfaRequired && !u.mfaEnabled,
    },
    passwordPolicy: { minLength: security.passwordMinLength, requiredClasses: security.passwordRequiredClasses },
  };
}
