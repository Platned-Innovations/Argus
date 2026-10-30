import { z } from 'zod';
import { ROLES, USER_STATUSES } from './roles';
import { PASSWORD_MAX_LENGTH } from './password-policy';

export const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({
  mfaToken: z.string().min(1).max(2000),
  code: z.string().trim().min(6).max(32),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const mfaEnableSchema = z.object({ code: z.string().trim().min(6).max(10) });
export const mfaDisableSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  code: z.string().trim().min(6).max(32),
});

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9._-]{3,64}$/, 'Use 3-64 letters, digits, dots, dashes or underscores.');

export const createUserSchema = z.object({
  username: usernameSchema,
  email: z.email().max(254).nullable().optional(),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  teamIds: z.array(z.uuid()).max(100).default([]),
  /** When omitted, a temporary password is generated and returned once. */
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    email: z.email().max(254).nullable(),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(ROLES),
    teamIds: z.array(z.uuid()).max(100),
    status: z.enum(USER_STATUSES),
  })
  .partial();
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const listUsersQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  teamId: z.uuid().optional(),
  ...pageFields,
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const teamSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullable().optional(),
});
export type TeamInput = z.infer<typeof teamSchema>;

export const securitySettingsSchema = z.object({
  passwordMinLength: z.number().int().min(8).max(128),
  passwordRequiredClasses: z.number().int().min(1).max(4),
  lockoutThreshold: z.number().int().min(3).max(50),
  lockoutMinutes: z.number().int().min(1).max(1440),
  mfaRequired: z.boolean(),
  accessTokenMinutes: z.number().int().min(5).max(60),
  sessionDays: z.number().int().min(1).max(90),
  /** Users with an email address can ask for a one-time sign-in link instead of using their password (MFA still applies). */
  signInLinks: z.boolean().default(false),
  /** Email channel that sends sign-in links. */
  signInLinkChannelId: z.uuid().nullable().default(null),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

/** Sign-in links are valid this long. */
export const SIGN_IN_LINK_MINUTES = 15;

export const signInLinkRequestSchema = z.object({ login: z.string().trim().min(1).max(254) });
/** The token travels in the body (it comes from the link's URL fragment), never in a URL the server logs. */
export const signInLinkVerifySchema = z.object({ token: z.string().min(10).max(200) });

/** Shown on the sign-in page before anyone signs in. */
export interface SignInOptionsDto {
  signInLinks: boolean;
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  passwordMinLength: 12,
  passwordRequiredClasses: 3,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
  mfaRequired: false,
  accessTokenMinutes: 15,
  sessionDays: 7,
  signInLinks: false,
  signInLinkChannelId: null,
};

export const auditQuerySchema = z.object({
  actorId: z.uuid().optional(),
  action: z.string().trim().max(100).optional(),
  targetType: z.string().trim().max(50).optional(),
  targetId: z.string().trim().max(100).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageFields,
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
