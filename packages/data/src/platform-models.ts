import { type Permission } from '@argus/shared';

/** A personal API token for CI and automation. Only a keyed hash of the token is stored. */
export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  /** First characters of the token, shown so people can tell tokens apart. */
  prefix: string;
  scopes: Permission[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export type NewApiToken = Pick<ApiToken, 'userId' | 'name' | 'tokenHash' | 'prefix' | 'scopes' | 'expiresAt'>;
