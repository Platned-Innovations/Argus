import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { createUserSchema, listUsersQuerySchema, updateUserSchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users:read')
  list(@Query(new ZodPipe(listUsersQuerySchema)) q: z.infer<typeof listUsersQuerySchema>) {
    return this.users.list(q);
  }

  @Get(':id')
  @RequirePermissions('users:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermissions('users:manage')
  create(@Body(new ZodPipe(createUserSchema)) body: z.infer<typeof createUserSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.users.create(body, me.user, requestContext(req));
  }

  @Patch(':id')
  @RequirePermissions('users:manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateUserSchema)) body: z.infer<typeof updateUserSchema>,
    @CurrentUser() me: RequestUser,
    @Req() req: Request,
  ) {
    return this.users.update(id, body, me.user, requestContext(req));
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @RequirePermissions('users:manage')
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.users.resetPassword(id, me.user, requestContext(req));
  }

  @Post(':id/reset-mfa')
  @HttpCode(200)
  @RequirePermissions('users:manage')
  resetMfa(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.users.resetMfa(id, me.user, requestContext(req));
  }

  @Post(':id/unlock')
  @HttpCode(200)
  @RequirePermissions('users:manage')
  unlock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.users.unlock(id, me.user, requestContext(req));
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @RequirePermissions('users:manage')
  revokeSessions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.users.revokeSessions(id, me.user, requestContext(req));
  }
}
