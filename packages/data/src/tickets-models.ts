import { type ChannelType, type NotificationEvent, type ScannerName, type Severity, type TicketEventType, type TicketStatus } from '@argus/shared';

export interface TicketJiraRecord {
  key: string;
  url: string;
  status: string | null;
  statusCategory: string | null;
  syncedAt: Date | null;
}

export interface Ticket {
  id: string;
  /** Human-friendly key, e.g. "ARG-42". */
  key: string;
  repoId: string;
  sourceId: string;
  teamId: string | null;
  scanner: ScannerName;
  /** Identity of the issue the ticket tracks within the repository; related findings share it. */
  groupKey: string;
  title: string;
  description: string | null;
  severity: Severity;
  riskScore: number;
  status: TicketStatus;
  assigneeId: string | null;
  watcherIds: string[];
  labels: string[];
  findingIds: string[];
  openFindings: number;
  remediation: string | null;
  dueAt: Date | null;
  slaBreachedAt: Date | null;
  /** Suppression created when the ticket was risk-accepted or marked a false positive. */
  suppressionId: string | null;
  jira: TicketJiraRecord | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
}

export type NewTicket = Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'lastActivityAt'>;
export type TicketPatch = Partial<Omit<Ticket, 'id' | 'key' | 'repoId' | 'sourceId' | 'groupKey' | 'createdAt' | 'updatedAt'>>;

export interface TicketListFilter {
  statuses?: TicketStatus[];
  severities?: Severity[];
  repoId?: string;
  scanner?: ScannerName;
  /** null = unassigned. */
  assigneeId?: string | null;
  /** Active tickets past their due date. */
  slaBreached?: boolean;
  /** Matches key, title or label. */
  search?: string;
  visibleTeamIds?: string[];
  ids?: string[];
  /** Exact ticket keys, e.g. "ARG-42". */
  keys?: string[];
  now: Date;
  offset: number;
  limit: number;
}

export interface TicketSummaryRecord {
  active: number;
  bySeverity: Record<Severity, number>;
  slaBreached: number;
  assignedTo: number;
  unassigned: number;
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  type: TicketEventType;
  actorId: string | null;
  actorName: string | null;
  body: string | null;
  data: Record<string, unknown> | null;
  createdAt: Date;
}

export type NewTicketEvent = Omit<TicketEvent, 'id' | 'createdAt'> & { createdAt?: Date };

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Client secret, SMTP password, webhook URL or signing secret — encrypted by the application. */
  secretEnc: string | null;
  secretHint: string | null;
  lastUsedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewChannel = Pick<Channel, 'name' | 'type' | 'enabled' | 'config' | 'secretEnc' | 'secretHint'>;
export type ChannelPatch = Partial<Omit<Channel, 'id' | 'type' | 'createdAt' | 'updatedAt'>>;

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  events: NotificationEvent[];
  minSeverity: Severity;
  teamIds: string[];
  channelIds: string[];
  recipients: string[];
  includeRepoRecipients: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NewNotificationRule = Omit<NotificationRule, 'id' | 'createdAt' | 'updatedAt'>;
