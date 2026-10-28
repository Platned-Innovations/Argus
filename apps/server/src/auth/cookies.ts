import { type CookieOptions, type Response } from 'express';

export const ACCESS_COOKIE = 'argus_at';
export const REFRESH_COOKIE = 'argus_rt';
export const CSRF_COOKIE = 'argus_csrf';
export const CSRF_HEADER = 'x-csrf-token';
/** Refresh cookie is only sent to the auth endpoints. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface IssuedTokens {
  accessToken: string;
  accessMaxAgeMs: number;
  refreshToken: string;
  refreshMaxAgeMs: number;
  csrfToken: string;
}

function base(secure: boolean): CookieOptions {
  return { secure, sameSite: 'strict' };
}

export function setAuthCookies(res: Response, tokens: IssuedTokens, secure: boolean): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base(secure), httpOnly: true, path: '/', maxAge: tokens.accessMaxAgeMs });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...base(secure), httpOnly: true, path: REFRESH_COOKIE_PATH, maxAge: tokens.refreshMaxAgeMs });
  // Readable by the SPA, which echoes it in the X-CSRF-Token header (double-submit pattern).
  res.cookie(CSRF_COOKIE, tokens.csrfToken, { ...base(secure), httpOnly: false, path: '/', maxAge: tokens.refreshMaxAgeMs });
}

export function clearAuthCookies(res: Response, secure: boolean): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(secure), httpOnly: true, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(secure), httpOnly: true, path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { ...base(secure), path: '/' });
}
