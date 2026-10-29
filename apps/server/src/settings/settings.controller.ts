import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import {
  type BrandingSettings,
  brandingSettingsSchema,
  type RetentionSettings,
  retentionSettingsSchema,
  type ScanningSettings,
  scanningSettingsSchema,
  type SecuritySettings,
  securitySettingsSchema,
  type SettingsExport,
  settingsExportSchema,
  type SettingsImportResultDto,
} from '@argus/shared';
import { type Request } from 'express';
import { AllowRestricted, CurrentUser, Public, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { SettingsTransferService } from './settings-transfer.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly transfer: SettingsTransferService,
  ) {}

  /** Public: the sign-in page shows the product name and notice before anyone signs in. */
  @Get('branding')
  @Public()
  @AllowRestricted()
  getBranding(): Promise<BrandingSettings> {
    return this.settings.getBranding();
  }

  @Put('branding')
  @RequirePermissions('settings:manage')
  async updateBranding(@Body(new ZodPipe(brandingSettingsSchema)) body: BrandingSettings, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<BrandingSettings> {
    const before = await this.settings.getBranding();
    const after = await this.settings.updateBranding(body, me.user.id);
    await this.audit.record({ action: 'settings.branding_updated', actor: me.user, details: { before, after }, ip: requestContext(req).ip });
    return after;
  }

  /** Configuration without secrets, as a JSON file to import into another installation. */
  @Get('export')
  @RequirePermissions('settings:manage')
  export(@CurrentUser() me: RequestUser, @Req() req: Request): Promise<SettingsExport> {
    return this.transfer.export(me.user, requestContext(req));
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermissions('settings:manage')
  import(@Body(new ZodPipe(settingsExportSchema)) body: SettingsExport, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<SettingsImportResultDto> {
    return this.transfer.import(body, me.user, requestContext(req));
  }

  @Get('security')
  @RequirePermissions('settings:read')
  getSecurity(): Promise<SecuritySettings> {
    return this.settings.getSecurity();
  }

  @Get('scanning')
  @RequirePermissions('settings:read')
  getScanning(): Promise<ScanningSettings> {
    return this.settings.getScanning();
  }

  @Put('scanning')
  @RequirePermissions('settings:manage')
  async updateScanning(@Body(new ZodPipe(scanningSettingsSchema)) body: ScanningSettings, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<ScanningSettings> {
    const before = await this.settings.getScanning();
    const after = await this.settings.updateScanning(body, me.user.id);
    const changed = (Object.keys(after) as (keyof ScanningSettings)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    await this.audit.record({
      action: 'settings.scanning_updated',
      actor: me.user,
      details: { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])) },
      ip: requestContext(req).ip,
    });
    return after;
  }

  @Get('retention')
  @RequirePermissions('settings:read')
  getRetention(): Promise<RetentionSettings> {
    return this.settings.getRetention();
  }

  @Put('retention')
  @RequirePermissions('settings:manage')
  async updateRetention(@Body(new ZodPipe(retentionSettingsSchema)) body: RetentionSettings, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<RetentionSettings> {
    const before = await this.settings.getRetention();
    const after = await this.settings.updateRetention(body, me.user.id);
    await this.audit.record({ action: 'settings.retention_updated', actor: me.user, details: { before, after }, ip: requestContext(req).ip });
    return after;
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
