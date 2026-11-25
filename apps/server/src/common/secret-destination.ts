import { BadRequestException } from '@nestjs/common';

/** The origin (scheme, host and port) of a URL, lower-cased; null stays null (the provider's default address). */
export function urlOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Stored secrets are write-only, but they are sent to a destination (a server, or a Microsoft Entra tenant). If the
 * destination could be changed while the stored secret is kept, the secret could be redirected to a server of the
 * caller's choosing without ever being read. So a stored secret is only reused with the destination it was entered
 * for: changing the destination needs the secret again.
 *
 * Returns the change (for the audit log), or null when the destination is unchanged.
 */
export function assertSecretReentered(
  before: string | null,
  after: string | null,
  opts: { hadSecret: boolean; secretProvided: boolean; what: string },
): { from: string | null; to: string | null } | null {
  if ((before ?? null) === (after ?? null)) return null;
  if (opts.hadSecret && !opts.secretProvided) {
    throw new BadRequestException({ statusCode: 400, message: `Enter the ${opts.what} again when changing the server address.`, code: 'SECRET_REENTRY_REQUIRED' });
  }
  return { from: before ?? null, to: after ?? null };
}
