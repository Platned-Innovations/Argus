import { Body, Controller, Get, HttpCode, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { aiProviderTestSchema, aiSettingsSchema, aiUsageQuerySchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AiService } from './ai.service';

@Controller('ai')
export class AiStatusController {
  constructor(private readonly ai: AiService) {}

  /** Which AI actions are available; lets the UI hide what is switched off. */
  @Get('status')
  @RequirePermissions('tickets:read')
  status() {
    return this.ai.status();
  }
}

@Controller('settings/ai')
@RequirePermissions('settings:manage')
export class AiSettingsController {
  constructor(private readonly ai: AiService) {}

  @Get()
  get() {
    return this.ai.getSettings();
  }

  @Put()
  update(@Body(new ZodPipe(aiSettingsSchema)) body: z.infer<typeof aiSettingsSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.ai.updateSettings(body, me.user, requestContext(req));
  }

  @Post('test')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  test(@Body(new ZodPipe(aiProviderTestSchema)) body: z.infer<typeof aiProviderTestSchema>, @CurrentUser() me: RequestUser) {
    return this.ai.test(body.provider, me.user);
  }

  @Get('usage')
  usage(@Query(new ZodPipe(aiUsageQuerySchema)) q: z.infer<typeof aiUsageQuerySchema>) {
    return this.ai.usage(q.month);
  }
}
