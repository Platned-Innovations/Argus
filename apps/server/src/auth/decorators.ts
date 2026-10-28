import { createParamDecorator, type ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { type Permission } from '@argus/shared';
import { type Request } from 'express';
import { type RequestUser } from '../common/request';

export const PUBLIC_KEY = 'argus:public';
export const ALLOW_RESTRICTED_KEY = 'argus:allowRestricted';
export const SKIP_CSRF_KEY = 'argus:skipCsrf';
export const PERMISSIONS_KEY = 'argus:permissions';

/** No authentication required. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Reachable while the user must still change their password or enroll in MFA. */
export const AllowRestricted = () => SetMetadata(ALLOW_RESTRICTED_KEY, true);

/** Exempt from the double-submit CSRF check (only for endpoints that establish a session). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);

/** Every listed permission is required. */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestUser => {
  const user = ctx.switchToHttp().getRequest<Request>().argusUser;
  if (!user) throw new UnauthorizedException();
  return user;
});
