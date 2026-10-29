import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { apiTokenCreateSchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { ApiTokensService } from './api-tokens.service';
import { CurrentUser, RequirePermissions, SessionOnly } from './decorators';

/** Token management is only possible from a signed-in session, so a leaked token cannot mint or hide other tokens. */
@Controller()
@SessionOnly()
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get('me/tokens')
  mine(@CurrentUser() me: RequestUser) {
    return this.tokens.listMine(me.user);
  }

  @Post('me/tokens')
  create(@Body(new ZodPipe(apiTokenCreateSchema)) body: z.infer<typeof apiTokenCreateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.tokens.create(body, me.user, requestContext(req));
  }

  @Delete('me/tokens/:id')
  @HttpCode(200)
  async revokeMine(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    await this.tokens.revoke(id, me.user, requestContext(req));
    return { ok: true };
  }

  /** Every token in the installation, for administrators. */
  @Get('api-tokens')
  @RequirePermissions('users:manage')
  all() {
    return this.tokens.listAll();
  }

  @Delete('api-tokens/:id')
  @HttpCode(200)
  @RequirePermissions('users:manage')
  async revokeAny(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    await this.tokens.revoke(id, me.user, requestContext(req));
    return { ok: true };
  }
}
