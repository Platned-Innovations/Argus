import { z } from 'zod';
import { scanningSettingsSchema } from './findings';
import { intelSettingsSchema, intelSourceSchema } from './intel';
import { retentionSettingsSchema } from './operations';
import { securitySettingsSchema } from './schemas';
import { ticketingSettingsSchema } from './tickets';

/** How this installation presents itself: in the web app, on the sign-in page, in emails and in authenticator apps. */
export const brandingSettingsSchema = z.object({
  productName: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^\p{Cc}<>]+$/u, 'Use letters, numbers, spaces and punctuation only.'),
  /** Shown on the sign-in page, e.g. an acceptable-use notice. Plain text. */
  loginNotice: z.string().trim().max(1000),
});
export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;

export const DEFAULT_BRANDING_SETTINGS: BrandingSettings = { productName: 'Argus', loginNotice: '' };

export const SETTINGS_EXPORT_FORMAT = 'argus-settings';

/**
 * A portable copy of an installation's configuration. It never contains secrets (credentials, API keys, channel
 * secrets) or anything tied to one installation's data (sources, repositories, users, teams, notification rules).
 */
export const settingsExportSchema = z.object({
  format: z.literal(SETTINGS_EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().max(40).optional(),
  settings: z
    .object({
      security: securitySettingsSchema,
      scanning: scanningSettingsSchema,
      ticketing: ticketingSettingsSchema,
      retention: retentionSettingsSchema,
      intel: intelSettingsSchema,
      branding: brandingSettingsSchema,
    })
    .partial(),
  /** News feeds; on import, feeds whose URL is already configured are skipped. */
  intelSources: z.array(intelSourceSchema).max(500).optional(),
});
export type SettingsExport = z.infer<typeof settingsExportSchema>;
export type SettingsSection = keyof SettingsExport['settings'];

export interface SettingsImportResultDto {
  /** Sections that were replaced. */
  applied: SettingsSection[];
  intelSourcesAdded: number;
  intelSourcesSkipped: number;
}
