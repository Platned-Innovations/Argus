import { z } from 'zod';
import { PERMISSIONS, type Permission } from './permissions';

/** Token prefix, so leaked tokens are easy to recognise (and to add to secret scanners). */
export const API_TOKEN_PREFIX = 'argus_pat_';

export const API_TOKEN_LIFETIMES_DAYS = [7, 30, 90, 180, 365] as const;

/** Read-only scopes, offered as a preset for CI and reporting integrations. */
export const READ_ONLY_SCOPES: Permission[] = ['repos:read', 'findings:read', 'tickets:read', 'reports:read', 'teams:read'];

export const apiTokenCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Permissions the token may use; they are further limited to the owner's role at every request. */
  scopes: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
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
