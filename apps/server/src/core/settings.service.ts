import { Inject, Injectable } from '@nestjs/common';
import { type DataStore } from '@argus/data';
import { DEFAULT_SECURITY_SETTINGS, type SecuritySettings, securitySettingsSchema } from '@argus/shared';
import { DATA_STORE } from './tokens';

const SECURITY_KEY = 'security';
const CACHE_MS = 15_000;

@Injectable()
export class SettingsService {
  private securityCache: { value: SecuritySettings; at: number } | null = null;

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

  async getSystemValue<T>(key: string): Promise<T | null> {
    return (await this.store.settings.get<T>(`system.${key}`))?.value ?? null;
  }

  async setSystemValue<T>(key: string, value: T): Promise<void> {
    await this.store.settings.set(`system.${key}`, value, null);
  }
}
