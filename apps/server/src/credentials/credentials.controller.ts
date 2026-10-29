import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { credentialSchema, credentialUpdateSchema, entraImportSettingsSchema, listCredentialsQuerySchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CredentialsService } from './credentials.service';

@Controller('credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Get()
  @RequirePermissions('findings:read')
  list(@Query(new ZodPipe(listCredentialsQuerySchema)) q: z.infer<typeof listCredentialsQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.credentials.list(q, me.user);
  }

  @Post()
  @RequirePermissions('credentials:manage')
  create(@Body(new ZodPipe(credentialSchema)) body: z.infer<typeof credentialSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.credentials.create(body, me.user, requestContext(req));
  }

  @Patch(':id')
  @RequirePermissions('credentials:manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(credentialUpdateSchema)) body: z.infer<typeof credentialUpdateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.credentials.update(id, body, me.user, requestContext(req));
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('credentials:manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    await this.credentials.remove(id, me.user, requestContext(req));
    return { ok: true };
  }

  @Get('entra')
  @RequirePermissions('settings:manage')
  entra() {
    return this.credentials.getEntraSettings();
  }

  @Put('entra')
  @RequirePermissions('settings:manage')
  updateEntra(@Body(new ZodPipe(entraImportSettingsSchema)) body: z.infer<typeof entraImportSettingsSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.credentials.updateEntraSettings(body, me.user, requestContext(req));
  }

  @Post('entra/sync')
  @HttpCode(200)
  @RequirePermissions('settings:manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  syncEntra(@CurrentUser() me: RequestUser) {
    return this.credentials.syncEntra(me.user);
  }
}
