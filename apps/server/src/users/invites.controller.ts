import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { inviteAcceptSchema, inviteCreateSchema, inviteLookupSchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { STRICT_LIMIT } from '../auth/auth.controller';
import { CurrentUser, Public, RequirePermissions, SessionOnly, SkipCsrf } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { InvitesService } from './invites.service';

@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get()
  @SessionOnly()
  @RequirePermissions('users:manage')
  list() {
    return this.invites.list();
  }

  /** Invites mint accounts, so only a signed-in administrator (not an API token) can create them. */
  @Post()
  @SessionOnly()
  @RequirePermissions('users:manage')
  create(@Body(new ZodPipe(inviteCreateSchema)) body: z.infer<typeof inviteCreateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.invites.create(body, me.user, requestContext(req));
  }

  @Delete(':id')
  @HttpCode(200)
  @SessionOnly()
  @RequirePermissions('users:manage')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    await this.invites.revoke(id, me.user, requestContext(req));
    return { ok: true };
  }

  @Post('lookup')
  @HttpCode(200)
  @Public()
  @SkipCsrf()
  @Throttle(STRICT_LIMIT)
  lookup(@Body(new ZodPipe(inviteLookupSchema)) body: z.infer<typeof inviteLookupSchema>) {
    return this.invites.preview(body.token);
  }

  @Post('accept')
  @HttpCode(200)
  @Public()
  @SkipCsrf()
  @Throttle(STRICT_LIMIT)
  accept(@Body(new ZodPipe(inviteAcceptSchema)) body: z.infer<typeof inviteAcceptSchema>, @Req() req: Request) {
    return this.invites.accept(body, requestContext(req));
  }
}
