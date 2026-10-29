import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from './password-policy';
import { ROLES, type Role } from './roles';
import { usernameSchema } from './schemas';

/** Invite links can be valid for at most this long. */
export const MAX_INVITE_DAYS = 365;
/** One link can create at most this many accounts (and list at most this many addresses). */
export const MAX_INVITE_USES = 500;

export const inviteCreateSchema = z.object({
  role: z.enum(ROLES),
  teamIds: z.array(z.uuid()).max(100).default([]),
  /**
   * When not empty, only these addresses can accept the invite, once each, and the address becomes the
   * account's email. The number of accounts is then the number of addresses (maxUses is ignored).
   */
  emails: z.array(z.email().max(254)).max(MAX_INVITE_USES).default([]),
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
  /** Required, and must be one of the invited addresses, when the invite is limited to addresses. */
  email: z.email().max(254).nullable().default(null),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type InviteAcceptInput = z.infer<typeof inviteAcceptSchema>;

/**
 * Emails the link to each invited address that has not signed up yet. The server never keeps the token, so the
 * administrator's browser sends it back (right after creating the invite); it must match the invite.
 */
export const inviteSendSchema = z.object({
  token: z.string().min(10).max(200),
  channelId: z.uuid(),
  /** Where the link points when ARGUS_PUBLIC_URL is not configured: the address the administrator uses. */
  baseUrl: z.url().max(500).optional(),
  message: z.string().trim().max(2000).default(''),
  /** Limit the send to these invited addresses (e.g. to retry the ones that failed). */
  only: z.array(z.email()).max(500).optional(),
});
export type InviteSendInput = z.infer<typeof inviteSendSchema>;

export interface InviteSendResultDto {
  sent: string[];
  failed: { email: string; error: string }[];
}

export type InviteStatus = 'active' | 'used' | 'expired' | 'revoked';

export interface InviteDto {
  id: string;
  role: Role;
  teamIds: string[];
  emails: string[];
  /** Invited addresses that have already created an account. */
  usedEmails: string[];
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
  /**
   * Shown once. The link is `<public URL>/invite#<token>`: the token is in the fragment, which browsers never send
   * to the server. Emailed links add the recipient's address (`#<token>&email=<address>`) to fill in the form.
   */
  token: string;
  /** Full link when ARGUS_PUBLIC_URL is configured; otherwise the browser builds it from its own address. */
  url: string | null;
}

/** What someone holding a valid link may see before accepting it (never the list of invited addresses). */
export interface InvitePreviewDto {
  role: Role;
  teams: string[];
  /** The invite is limited to particular addresses: the invitee must give theirs. */
  emailRequired: boolean;
  expiresAt: string;
}

/** Splits an invite fragment (`<token>` or `<token>&email=<address>`). */
export function parseInviteFragment(fragment: string): { token: string; email: string | null } {
  const [token = '', rest = ''] = fragment.replace(/^#/, '').split(/&(.*)/s);
  return { token, email: new URLSearchParams(rest).get('email') };
}
