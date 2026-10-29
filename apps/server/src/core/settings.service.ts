import { Inject, Injectable } from '@nestjs/common';
import { type DataStore } from '@argus/data';
import {
  type BrandingSettings,
  brandingSettingsSchema,
  DEFAULT_BRANDING_SETTINGS,
  DEFAULT_INTEL_SETTINGS,
  DEFAULT_RETENTION_SETTINGS,
  type IntelSettings,
  intelSettingsSchema,
  DEFAULT_SCANNING_SETTINGS,
  type RetentionSettings,
  retentionSettingsSchema,
  DEFAULT_SECURITY_SETTINGS,
  DEFAULT_TICKETING_SETTINGS,
  type ScanningSettings,
  scanningSettingsSchema,
  type SecuritySettings,
  securitySettingsSchema,
  type TicketingSettings,
  ticketingSettingsSchema,
} from '@argus/shared';
import { DATA_STORE } from './tokens';

const SECURITY_KEY = 'security';
const SCANNING_KEY = 'scanning';
const TICKETING_KEY = 'ticketing';
const RETENTION_KEY = 'retention';
const BRANDING_KEY = 'branding';
const INTEL_KEY = 'intel';
const CACHE_MS = 15_000;

@Injectable()
export class SettingsService {
  private securityCache: { value: SecuritySettings; at: number } | null = null;
  private brandingCache: { value: BrandingSettings; at: number } | null = null;

  constructor(@Inject(DATA_STORE) private readonly store: DataStore) {}

  async getSecurity(): Promise<SecuritySettings> {
    if (this.securityCache && Date.now() - this.securityCache.at < CACHE_MS) return this.securityCache.value;
    const stored = await this.store.settings.get<Partial<SecuritySettings>>(SECURITY_KEY);
    // Merge over defaults so settings added in newer versions get sane values; drop anything invalid.
    const merged = securitySettingsSchema.safeParse({ ...DEFAULT_SECURITY_SETTINGS, ...(stored?.value ?? {}) });
    const value = merged.success ? merged.data : DEFAULT_SECURITY_SETTINGS;
    this.securityCache = { value, at: Date.now() };
    return value;
  }

  async updateSecurity(value: SecuritySettings, actorId: string): Promise<SecuritySettings> {
    await this.store.settings.set(SECURITY_KEY, value, actorId);
    this.securityCache = null;
    return this.getSecurity();
  }

  async getScanning(): Promise<ScanningSettings> {
    const stored = await this.store.settings.get<Partial<ScanningSettings>>(SCANNING_KEY);
    const v = stored?.value ?? {};
    const merged = scanningSettingsSchema.safeParse({
      ...DEFAULT_SCANNING_SETTINGS,
      ...v,
      riskWeights: { ...DEFAULT_SCANNING_SETTINGS.riskWeights, ...(v.riskWeights ?? {}) },
    });
    return merged.success ? merged.data : DEFAULT_SCANNING_SETTINGS;
  }

  async updateScanning(value: ScanningSettings, actorId: string): Promise<ScanningSettings> {
    await this.store.settings.set(SCANNING_KEY, value, actorId);
    return this.getScanning();
  }

  async getTicketing(): Promise<TicketingSettings> {
    const v = (await this.store.settings.get<Partial<TicketingSettings>>(TICKETING_KEY))?.value ?? {};
    const merged = ticketingSettingsSchema.safeParse({ ...DEFAULT_TICKETING_SETTINGS, ...v, slaDays: { ...DEFAULT_TICKETING_SETTINGS.slaDays, ...(v.slaDays ?? {}) } });
    return merged.success ? merged.data : DEFAULT_TICKETING_SETTINGS;
  }

  async updateTicketing(value: TicketingSettings, actorId: string): Promise<TicketingSettings> {
    await this.store.settings.set(TICKETING_KEY, value, actorId);
    return this.getTicketing();
  }

  async getRetention(): Promise<RetentionSettings> {
    const v = (await this.store.settings.get<Partial<RetentionSettings>>(RETENTION_KEY))?.value ?? {};
    const merged = retentionSettingsSchema.safeParse({ ...DEFAULT_RETENTION_SETTINGS, ...v });
    return merged.success ? merged.data : DEFAULT_RETENTION_SETTINGS;
  }

  async updateRetention(value: RetentionSettings, actorId: string): Promise<RetentionSettings> {
    await this.store.settings.set(RETENTION_KEY, value, actorId);
    return this.getRetention();
  }

  /** Read on every page load and email, so it is cached briefly like the security settings. */
  async getBranding(): Promise<BrandingSettings> {
    if (this.brandingCache && Date.now() - this.brandingCache.at < CACHE_MS) return this.brandingCache.value;
    const v = (await this.store.settings.get<Partial<BrandingSettings>>(BRANDING_KEY))?.value ?? {};
    const merged = brandingSettingsSchema.safeParse({ ...DEFAULT_BRANDING_SETTINGS, ...v });
    const value = merged.success ? merged.data : DEFAULT_BRANDING_SETTINGS;
    this.brandingCache = { value, at: Date.now() };
    return value;
  }

  async updateBranding(value: BrandingSettings, actorId: string): Promise<BrandingSettings> {
    await this.store.settings.set(BRANDING_KEY, value, actorId);
    this.brandingCache = null;
    return this.getBranding();
  }

  async getIntel(): Promise<IntelSettings> {
    const v = (await this.store.settings.get<Partial<IntelSettings>>(INTEL_KEY))?.value ?? {};
    const merged = intelSettingsSchema.safeParse({ ...DEFAULT_INTEL_SETTINGS, ...v });
    return merged.success ? merged.data : DEFAULT_INTEL_SETTINGS;
  }

  async updateIntel(value: IntelSettings, actorId: string): Promise<IntelSettings> {
    await this.store.settings.set(INTEL_KEY, value, actorId);
    return this.getIntel();
  }

  async getSystemValue<T>(key: string): Promise<T | null> {
    return (await this.store.settings.get<T>(`system.${key}`))?.value ?? null;
  }

  async setSystemValue<T>(key: string, value: T): Promise<void> {
    await this.store.settings.set(`system.${key}`, value, null);
  }
}
