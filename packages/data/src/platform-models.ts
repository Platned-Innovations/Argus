import { type CredentialKind, type CredentialSource, type FindingStatus, type Permission, type SavedViewPage, type ScannerName, type Severity, type TicketStatus } from '@argus/shared';

/** Scope of dashboard statistics. */
export interface StatsFilter {
  visibleTeamIds?: string[];
  teamId?: string;
  repoId?: string;
  /** Rows that were fixed, resolved or created before this and are no longer active are left out. */
  since: Date;
}

/** The fields of a finding that dashboards need. */
export interface FindingStatRow {
  repoId: string;
  scanner: ScannerName;
  severity: Severity;
  riskScore: number;
  status: FindingStatus;
  firstSeenAt: Date;
  fixedAt: Date | null;
  title: string;
  details: Record<string, unknown> | null;
}

/** The fields of a ticket that dashboards need. */
export interface TicketStatRow {
  severity: Severity;
  status: TicketStatus;
  createdAt: Date;
  dueAt: Date | null;
  resolvedAt: Date | null;
}

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

/** A tracked credential (never the secret itself): what it is, who owns it and when it expires. */
export interface Credential {
  id: string;
  name: string;
  kind: CredentialKind;
  system: string;
  owner: string;
  teamId: string | null;
  expiresAt: Date;
  notes: string;
  notifyEmails: string[];
  source: CredentialSource;
  /** Identity in the source it was imported from (e.g. Entra application id and key id). */
  externalId: string | null;
  archived: boolean;
  /** The smallest notice threshold (days before expiry) already sent, so each notice goes out once. */
  lastNoticeDays: number | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewCredential = Omit<Credential, 'id' | 'createdAt' | 'updatedAt' | 'lastNoticeDays'>;
export type CredentialPatch = Partial<Omit<Credential, 'id' | 'createdAt' | 'updatedAt' | 'source' | 'externalId'>>;

export interface CredentialListFilter {
  /** null-team (organisation-wide) credentials are only visible without this restriction. */
  visibleTeamIds?: string[];
  teamId?: string;
  /** Matches name, system or owner. */
  search?: string;
  expiresBefore?: Date;
  archived?: boolean;
  offset: number;
  limit: number;
}

/** A named set of list filters (a URL query string), private to its owner unless shared. */
export interface SavedView {
  id: string;
  userId: string;
  page: SavedViewPage;
  name: string;
  query: string;
  shared: boolean;
  createdAt: Date;
}

export type NewSavedView = Omit<SavedView, 'id' | 'createdAt'>;
