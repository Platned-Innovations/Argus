import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from './password-policy';
import { ROLES, type Role } from './roles';
import { usernameSchema } from './schemas';

/** Invite links can be valid for at most this long. */
export const MAX_INVITE_DAYS = 365;
/** One link can create at most this many accounts. */
export const MAX_INVITE_USES = 500;

export const inviteCreateSchema = z.object({
  role: z.enum(ROLES),
  teamIds: z.array(z.uuid()).max(100).default([]),
  /** When set, only this address can accept the invite, and it becomes the account's email. */
  email: z.email().max(254).nullable().default(null),
  maxUses: z.number().int().min(1).max(MAX_INVITE_USES).default(1),
  expiresAt: z.coerce.date(),
  /** Shown to administrators only, e.g. who the link was sent to. */
  note: z.string().trim().max(200).default(''),
});
export type InviteCreateInput = z.infer<typeof inviteCreateSchema>;

/** The token travels in the body, never the URL, so it stays out of request logs. */
export const inviteLookupSchema = z.object({ token: z.string().min(10).max(200) });

export const inviteAcceptSchema = inviteLookupSchema.extend({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(120),
  /** Ignored when the invite is for a specific address. */
  email: z.email().max(254).nullable().default(null),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type InviteAcceptInput = z.infer<typeof inviteAcceptSchema>;

export type InviteStatus = 'active' | 'used' | 'expired' | 'revoked';

export interface InviteDto {
  id: string;
  role: Role;
  teamIds: string[];
  email: string | null;
  maxUses: number;
  uses: number;
  expiresAt: string;
  note: string;
  status: InviteStatus;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface InviteCreatedDto {
  invite: InviteDto;
  /** Shown once. The link is `<public URL>/invite#<token>`: the token is in the fragment, which browsers never send to the server. */
  token: string;
  /** Full link when ARGUS_PUBLIC_URL is configured; otherwise the browser builds it from its own address. */
  url: string | null;
}

/** What someone holding a valid link may see before accepting it. */
export interface InvitePreviewDto {
  role: Role;
  teams: string[];
  email: string | null;
  expiresAt: string;
}
