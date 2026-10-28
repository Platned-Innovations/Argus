import { type User } from '@argus/data';
import { type Request } from 'express';

export interface RequestUser {
  user: User;
  sessionId: string;
  mfaEnrollmentRequired: boolean;
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
