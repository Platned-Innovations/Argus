import { z } from 'zod';
import { pageFields } from './schemas';

export const CREDENTIAL_KINDS = ['api_key', 'client_secret', 'certificate', 'password', 'token', 'ssh_key', 'other'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const CREDENTIAL_KIND_LABELS: Record<CredentialKind, string> = {
  api_key: 'API key',
  client_secret: 'Client secret',
  certificate: 'Certificate',
  password: 'Password',
  token: 'Access token',
  ssh_key: 'SSH key',
  other: 'Other',
};

export const CREDENTIAL_SOURCES = ['manual', 'entra'] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** Days before expiry at which owners are notified (and at expiry). */
export const CREDENTIAL_NOTICE_DAYS = [30, 14, 7, 1, 0] as const;

/**
 * A tracked credential. Argus never stores the secret itself, only what it is, where it is used, who owns it
 * and when it expires.
 */
export const credentialSchema = z.object({
  name: z.string().trim().min(2).max(200),
  kind: z.enum(CREDENTIAL_KINDS),
  /** The system it belongs to or unlocks, e.g. "Stripe", "Azure SQL prod". */
  system: z.string().trim().max(200).default(''),
  owner: z.string().trim().max(200).default(''),
  teamId: z.uuid().nullable().default(null),
  expiresAt: z.coerce.date(),
  notes: z.string().trim().max(2000).default(''),
  /** Where to send expiry notices, in addition to notification rules. */
  notifyEmails: z.array(z.email()).max(20).default([]),
});
export type CredentialInput = z.infer<typeof credentialSchema>;

export interface CredentialDto extends Omit<CredentialInput, 'expiresAt'> {
  id: string;
  expiresAt: string;
  daysLeft: number;
  source: CredentialSource;
  /** For imported credentials, e.g. the Entra application id and key id. */
  externalId: string | null;
  archived: boolean;
  teamName: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listCredentialsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  teamId: z.uuid().optional(),
  /** Only credentials expiring within this many days (negative values include expired ones only). */
  expiringWithinDays: z.coerce.number().int().min(-3650).max(3650).optional(),
  archived: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  ...pageFields,
});
export type ListCredentialsQuery = z.infer<typeof listCredentialsQuerySchema>;

export const credentialUpdateSchema = credentialSchema.partial().extend({ archived: z.boolean().optional() });
export type CredentialUpdateInput = z.infer<typeof credentialUpdateSchema>;

/** Microsoft Entra ID import: application registrations' client secrets and certificates. */
export const entraImportSettingsSchema = z.object({
  enabled: z.boolean(),
  tenantId: z.string().trim().min(1).max(100),
  clientId: z.string().trim().min(1).max(100),
  /** Write-only. Omit to keep the stored secret. */
  clientSecret: z.string().min(1).max(4096).optional(),
  /** Team that imported credentials belong to (null = organisation-wide). */
  teamId: z.uuid().nullable().default(null),
});
export type EntraImportSettingsInput = z.infer<typeof entraImportSettingsSchema>;

export interface EntraImportSettingsDto extends Omit<EntraImportSettingsInput, 'clientSecret'> {
  secretConfigured: boolean;
  secretHint: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncCount: number | null;
}
