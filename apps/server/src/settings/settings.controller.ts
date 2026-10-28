import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { type SecuritySettings, securitySettingsSchema } from '@argus/shared';
import { type Request } from 'express';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get('security')
  @RequirePermissions('settings:read')
  getSecurity(): Promise<SecuritySettings> {
    return this.settings.getSecurity();
  }

  @Put('security')
  @RequirePermissions('settings:manage')
  async updateSecurity(@Body(new ZodPipe(securitySettingsSchema)) body: SecuritySettings, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<SecuritySettings> {
    const before = await this.settings.getSecurity();
    const after = await this.settings.updateSecurity(body, me.user.id);
    const changed = Object.fromEntries(
      (Object.keys(after) as (keyof SecuritySettings)[]).filter((k) => before[k] !== after[k]).map((k) => [k, { from: before[k], to: after[k] }]),
    );
    await this.audit.record({ action: 'settings.security_updated', actor: me.user, details: { changed }, ip: requestContext(req).ip });
    return after;
  }
}
