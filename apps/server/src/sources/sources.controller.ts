import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { sourceCreateSchema, sourceTestSchema, sourceUpdateSchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { SourcesService } from './sources.service';

/** Connection tests call out to third-party APIs; keep them from being used as a request amplifier. */
const TEST_LIMIT = { default: { limit: 20, ttl: 60_000 } };

@Controller('sources')
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  @RequirePermissions('sources:manage')
  list() {
    return this.sources.list();
  }

  /** Names only, for repository filters (visible to anyone who can see repositories). */
  @Get('summary')
  @RequirePermissions('repos:read')
  summary() {
    return this.sources.summaries();
  }

  @Post('test')
  @HttpCode(200)
  @RequirePermissions('sources:manage')
  @Throttle(TEST_LIMIT)
  test(@Body(new ZodPipe(sourceTestSchema)) body: z.infer<typeof sourceTestSchema>) {
    return this.sources.test(body);
  }

  @Get(':id')
  @RequirePermissions('sources:manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.get(id);
  }

  @Post()
  @RequirePermissions('sources:manage')
  @Throttle(TEST_LIMIT)
  create(@Body(new ZodPipe(sourceCreateSchema)) body: z.infer<typeof sourceCreateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.sources.create(body, me.user, requestContext(req));
  }

  @Patch(':id')
  @RequirePermissions('sources:manage')
  @Throttle(TEST_LIMIT)
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sourceUpdateSchema)) body: z.infer<typeof sourceUpdateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.sources.update(id, body, me.user, requestContext(req));
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('sources:manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    await this.sources.remove(id, me.user, requestContext(req));
    return { ok: true };
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequirePermissions('sources:manage')
  @Throttle(TEST_LIMIT)
  testExisting(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.testExisting(id);
  }

  @Post(':id/sync')
  @HttpCode(202)
  @RequirePermissions('sources:manage')
  sync(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.sources.requestSync(id, me.user, requestContext(req));
  }

  @Post(':id/webhook-secret')
  @HttpCode(200)
  @RequirePermissions('sources:manage')
  rotateSecret(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.sources.rotateWebhookSecret(id, me.user, requestContext(req));
  }
}
