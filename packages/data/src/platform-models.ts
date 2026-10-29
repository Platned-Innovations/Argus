import { type FindingStatus, type Permission, type ScannerName, type Severity, type TicketStatus } from '@argus/shared';

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
