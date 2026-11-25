import { z } from 'zod';
import { PERMISSIONS, type Permission } from './permissions';

/** Token prefix, so leaked tokens are easy to recognise (and to add to secret scanners). */
export const API_TOKEN_PREFIX = 'argus_pat_';

export const API_TOKEN_LIFETIMES_DAYS = [7, 30, 90, 180, 365] as const;

/** Read-only scopes, offered as a preset for CI and reporting integrations. */
export const READ_ONLY_SCOPES: Permission[] = ['repos:read', 'findings:read', 'tickets:read', 'reports:read', 'teams:read'];

/**
 * High-risk permissions a token can never hold or use: they manage accounts, teams, settings and the secrets that
 * connect Argus to other systems. A leaked token must not be able to take over an account or redirect a stored
 * secret, so these stay with signed-in users.
 */
export const SESSION_ONLY_PERMISSIONS: readonly Permission[] = ['users:manage', 'teams:manage', 'settings:manage', 'sources:manage'];

/** Permissions an API token may be given. */
export const TOKEN_SCOPES = PERMISSIONS.filter((p) => !SESSION_ONLY_PERMISSIONS.includes(p)) as [Permission, ...Permission[]];

export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Permissions the token may use; they are further limited to the owner's role at every request. */
  scopes: z.array(z.enum(TOKEN_SCOPES, { error: 'API tokens cannot hold the users:manage, teams:manage, settings:manage or sources:manage scopes.' })).min(1).max(TOKEN_SCOPES.length),
  expiresInDays: z.number().int().refine((d) => (API_TOKEN_LIFETIMES_DAYS as readonly number[]).includes(d), 'Choose 7, 30, 90, 180 or 365 days.'),
});
export type ApiTokenCreateInput = z.infer<typeof apiTokenCreateSchema>;

export interface ApiTokenDto {
  id: string;
  name: string;
  /** First characters of the token, for recognising it. */
  prefix: string;
  scopes: Permission[];
  userId: string;
  userName: string | null;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned once, when the token is created. */
export interface ApiTokenCreatedDto extends ApiTokenDto {
  token: string;
}
