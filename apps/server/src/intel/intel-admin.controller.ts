import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { advisoryInputSchema, advisoryUpdateSchema, intelReviewSchema, intelSettingsSchema, intelSourceSchema, listAdvisoriesQuerySchema, listIntelItemsQuerySchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AdvisoriesService } from './advisories.service';
import { NewsService } from './news.service';
import { RematchService } from './rematch.service';

/** Outbound fetches and AI calls on demand. */
const ON_DEMAND = { default: { limit: 10, ttl: 60_000 } };

@Controller('intel')
export class IntelAdminController {
  constructor(
    private readonly news: NewsService,
    private readonly advisories: AdvisoriesService,
    private readonly rematch: RematchService,
  ) {}

  @Get('overview')
  @RequirePermissions('findings:read')
  overview() {
    return this.news.overview();
  }

  @Get('items')
  @RequirePermissions('findings:read')
  items(@Query(new ZodPipe(listIntelItemsQuerySchema)) q: z.infer<typeof listIntelItemsQuerySchema>) {
    return this.news.listItems(q);
  }

  @Post('items/:id/review')
  @HttpCode(200)
  @RequirePermissions('intel:manage')
  review(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(intelReviewSchema)) body: z.infer<typeof intelReviewSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.news.review(id, body, me.user, requestContext(req));
  }

  @Post('items/:id/reanalyse')
  @HttpCode(200)
  @RequirePermissions('intel:manage', 'ai:use')
  @Throttle(ON_DEMAND)
  async reanalyse(@Param('id', ParseUUIDPipe) id: string) {
    await this.news.reanalyse(id);
    return { ok: true };
  }

  @Get('sources')
  @RequirePermissions('intel:manage')
  sources() {
    return this.news.listSources();
  }

  @Post('sources')
  @RequirePermissions('intel:manage')
  createSource(@Body(new ZodPipe(intelSourceSchema)) body: z.infer<typeof intelSourceSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.news.createSource(body, me.user, requestContext(req));
  }

  @Put('sources/:id')
  @RequirePermissions('intel:manage')
  updateSource(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(intelSourceSchema)) body: z.infer<typeof intelSourceSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.news.updateSource(id, body, me.user, requestContext(req));
  }

  @Delete('sources/:id')
  @HttpCode(200)
  @RequirePermissions('intel:manage')
  async deleteSource(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    await this.news.deleteSource(id, me.user, requestContext(req));
    return { ok: true };
  }

  @Post('sources/:id/fetch')
  @HttpCode(200)
  @RequirePermissions('intel:manage')
  @Throttle(ON_DEMAND)
  fetchSource(@Param('id', ParseUUIDPipe) id: string) {
    return this.news.fetchNow(id);
  }

  @Get('advisories')
  @RequirePermissions('findings:read')
  listAdvisories(@Query(new ZodPipe(listAdvisoriesQuerySchema)) q: z.infer<typeof listAdvisoriesQuerySchema>) {
    return this.advisories.list(q);
  }

  @Post('advisories')
  @RequirePermissions('intel:manage')
  createAdvisory(@Body(new ZodPipe(advisoryInputSchema)) body: z.infer<typeof advisoryInputSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.advisories.create(body, me.user, requestContext(req));
  }

  @Patch('advisories/:id')
  @RequirePermissions('intel:manage')
  updateAdvisory(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(advisoryUpdateSchema)) body: z.infer<typeof advisoryUpdateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.advisories.setWithdrawn(id, body.withdrawn, me.user, requestContext(req));
  }

  @Post('rematch')
  @HttpCode(202)
  @RequirePermissions('intel:manage')
  @Throttle(ON_DEMAND)
  async rematchNow() {
    await this.rematch.enqueue('manual');
    return { queued: true };
  }

  @Get('settings')
  @RequirePermissions('intel:manage')
  settings() {
    return this.rematch.intelSettings();
  }

  @Put('settings')
  @RequirePermissions('settings:manage')
  updateSettings(@Body(new ZodPipe(intelSettingsSchema)) body: z.infer<typeof intelSettingsSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.advisories.updateSettings(body, me.user, requestContext(req));
  }
}
