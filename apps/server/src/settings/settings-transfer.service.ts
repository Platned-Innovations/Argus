import { Inject, Injectable } from '@nestjs/common';
import { type DataStore, type User } from '@argus/data';
import { SETTINGS_EXPORT_FORMAT, type SettingsExport, type SettingsImportResultDto, type SettingsSection } from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';

/**
 * Exports and imports configuration between installations (or as a backup of it). Secrets are never part of it:
 * credentials and keys stay encrypted in the installation that holds them.
 */
@Injectable()
export class SettingsTransferService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async export(actor: User, ctx: RequestContext): Promise<SettingsExport> {
    const out: SettingsExport = {
      format: SETTINGS_EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        security: await this.settings.getSecurity(),
        scanning: await this.settings.getScanning(),
        ticketing: await this.settings.getTicketing(),
        retention: await this.settings.getRetention(),
        intel: await this.settings.getIntel(),
        branding: await this.settings.getBranding(),
      },
      intelSources: (await this.store.intelSources.list()).map((s) => ({ name: s.name, url: s.url, enabled: s.enabled, intervalMinutes: s.intervalMinutes })),
    };
    await this.audit.record({ action: 'settings.exported', actor, ip: ctx.ip });
    return out;
  }

  /** Replaces each section present in the file; sections left out are not touched. */
  async import(data: SettingsExport, actor: User, ctx: RequestContext): Promise<SettingsImportResultDto> {
    const s = data.settings;
    const applied: SettingsSection[] = [];
    if (s.security) await this.settings.updateSecurity(s.security, actor.id).then(() => applied.push('security'));
    if (s.scanning) await this.settings.updateScanning(s.scanning, actor.id).then(() => applied.push('scanning'));
    if (s.ticketing) await this.settings.updateTicketing(s.ticketing, actor.id).then(() => applied.push('ticketing'));
    if (s.retention) await this.settings.updateRetention(s.retention, actor.id).then(() => applied.push('retention'));
    if (s.intel) await this.settings.updateIntel(s.intel, actor.id).then(() => applied.push('intel'));
    if (s.branding) await this.settings.updateBranding(s.branding, actor.id).then(() => applied.push('branding'));

    let added = 0;
    let skipped = 0;
    if (data.intelSources?.length) {
      const known = new Set((await this.store.intelSources.list()).map((x) => x.url.toLowerCase()));
      for (const src of data.intelSources) {
        if (known.has(src.url.toLowerCase())) {
          skipped++;
          continue;
        }
        known.add(src.url.toLowerCase());
        await this.store.intelSources.create(src);
        added++;
      }
    }
    const result: SettingsImportResultDto = { applied, intelSourcesAdded: added, intelSourcesSkipped: skipped };
    await this.audit.record({ action: 'settings.imported', actor, details: { ...result, exportedAt: data.exportedAt ?? null }, ip: ctx.ip });
    return result;
  }
}
