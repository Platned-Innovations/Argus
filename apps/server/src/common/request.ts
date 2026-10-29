import { type User } from '@argus/data';
import { type Permission } from '@argus/shared';
import { type Request } from 'express';

export interface RequestUser {
  user: User;
  sessionId: string;
  mfaEnrollmentRequired: boolean;
  /** Set when the request authenticated with a personal API token instead of a session. */
  apiToken?: { id: string; scopes: Permission[] };
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    argusUser?: RequestUser;
  }
}

export function requestContext(req: Request): RequestContext {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 512) ?? null };
}
