import { z } from 'zod';
import { SCANNERS, type ScannerName, type Severity, SEVERITIES } from './findings';
import { pageFields } from './schemas';

export const TICKET_STATUSES = ['open', 'triaged', 'in_progress', 'reopened', 'resolved', 'closed', 'risk_accepted', 'false_positive'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses in which a ticket still needs work (counts towards SLA). */
export const ACTIVE_TICKET_STATUSES: TicketStatus[] = ['open', 'triaged', 'in_progress', 'reopened'];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  triaged: 'Triaged',
  in_progress: 'In progress',
  reopened: 'Reopened',
  resolved: 'Resolved',
  closed: 'Closed',
  risk_accepted: 'Risk accepted',
  false_positive: 'False positive',
};

/** Changing to these statuses needs the tickets:triage permission and creates a suppression. */
export const TRIAGE_ONLY_STATUSES: TicketStatus[] = ['risk_accepted', 'false_positive'];

export const TICKET_EVENT_TYPES = [
  'created',
  'comment',
  'status',
  'assignment',
  'labels',
  'findings',
  'auto_resolved',
  'reopened',
  'sla_breached',
  'email_sent',
  'jira_created',
  'jira_status',
  'ai_suggestion',
] as const;
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];

export interface TicketJiraLink {
  key: string;
  url: string;
  status: string | null;
  /** Jira status category: "new", "indeterminate" or "done". */
  statusCategory: string | null;
  syncedAt: string | null;
}

export interface TicketDto {
  id: string;
  key: string;
  repoId: string;
  repoFullName: string | null;
  teamId: string | null;
  scanner: ScannerName;
  title: string;
  description: string | null;
  severity: Severity;
  riskScore: number;
  status: TicketStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  watcherIds: string[];
  labels: string[];
  dueAt: string | null;
  slaBreached: boolean;
  openFindings: number;
  totalFindings: number;
  suppressionId: string | null;
  jira: TicketJiraLink | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface TicketEventDto {
  id: string;
  ticketId: string;
  type: TicketEventType;
  actorId: string | null;
  actorName: string | null;
  body: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface TicketDetailDto extends TicketDto {
  findingIds: string[];
  remediation: string | null;
  events: TicketEventDto[];
}

export interface TicketSummaryDto {
  active: number;
  bySeverity: Record<Severity, number>;
  slaBreached: number;
  assignedToMe: number;
  unassigned: number;
}

const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item).max(20)).optional();

export const listTicketsQuerySchema = z.object({
  /** "active" is a shortcut for open, triaged, in progress and reopened. */
  status: z.union([z.literal('active'), z.enum(TICKET_STATUSES)]).optional(),
  severity: csv(z.enum(SEVERITIES)),
  repoId: z.uuid().optional(),
  scanner: z.enum(SCANNERS).optional(),
  /** "me", "none" or a user id. */
  assignee: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
  slaBreached: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  search: z.string().trim().max(200).optional(),
  ...pageFields,
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export const ticketUpdateSchema = z
  .object({
    assigneeId: z.uuid().nullable(),
    labels: z.array(z.string().trim().min(1).max(40)).max(20),
  })
  .partial();
export type TicketUpdateInput = z.infer<typeof ticketUpdateSchema>;

export const ticketStatusSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    /** Required for risk acceptance, false positive and closing. */
    reason: z.string().trim().min(5).max(2000).optional(),
    /** Risk acceptance expiry; after it the ticket reopens at the next scan. */
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .refine((s) => !['risk_accepted', 'false_positive'].includes(s.status) || !!s.reason, { message: 'A justification is required.', path: ['reason'] });
export type TicketStatusInput = z.infer<typeof ticketStatusSchema>;

export const ticketCommentSchema = z.object({ body: z.string().trim().min(1).max(10_000) });

export const ticketBulkSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
  assigneeId: z.uuid().nullable().optional(),
  status: z.enum(['open', 'triaged', 'in_progress', 'resolved', 'closed']).optional(),
});
export type TicketBulkInput = z.infer<typeof ticketBulkSchema>;

export const ticketEmailSchema = z.object({
  channelId: z.uuid(),
  to: z.array(z.email()).min(1).max(20),
  cc: z.array(z.email()).max(20).default([]),
  message: z.string().trim().max(5000).default(''),
});
export type TicketEmailInput = z.infer<typeof ticketEmailSchema>;

export const ticketJiraSchema = z.object({
  /** Defaults to the repository's Jira project key. */
  projectKey: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,49}$/).optional(),
  issueType: z.string().trim().min(1).max(60).optional(),
  /** Overrides the generated summary and description, e.g. after editing an AI draft. */
  summary: z.string().trim().min(1).max(250).optional(),
  description: z.string().trim().min(1).max(30_000).optional(),
});
export type TicketJiraInput = z.infer<typeof ticketJiraSchema>;

export interface AssigneeDto {
  id: string;
  displayName: string;
  username: string;
}

// ---------------------------------------------------------------- settings

export const ticketingSettingsSchema = z.object({
  /** Findings at or above this severity open tickets automatically. */
  autoCreateMinSeverity: z.enum(SEVERITIES),
  /** Days to resolve, by severity. */
  slaDays: z.object({ critical: z.number().int().min(1).max(365), high: z.number().int().min(1).max(365), medium: z.number().int().min(1).max(730), low: z.number().int().min(1).max(730), info: z.number().int().min(1).max(730) }),
});
export type TicketingSettings = z.infer<typeof ticketingSettingsSchema>;

export const DEFAULT_TICKETING_SETTINGS: TicketingSettings = {
  autoCreateMinSeverity: 'low',
  slaDays: { critical: 7, high: 30, medium: 90, low: 180, info: 365 },
};

// ---------------------------------------------------------------- notification channels

export const CHANNEL_TYPES = ['email_graph', 'email_smtp', 'teams_webhook', 'slack_webhook', 'webhook'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  email_graph: 'Email via Microsoft Graph',
  email_smtp: 'Email via SMTP (Microsoft 365, Google, other)',
  teams_webhook: 'Microsoft Teams webhook',
  slack_webhook: 'Slack webhook',
  webhook: 'Signed webhook (JSON)',
};

export const isEmailChannel = (t: ChannelType) => t === 'email_graph' || t === 'email_smtp';

export const SMTP_AUTH_MODES = ['password', 'microsoft_oauth2', 'none'] as const;

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
/** HTTPS, or plain HTTP only on loopback (local development) — the same rule as source URLs. */
const https = z.url().refine((u) => u.startsWith('https://') || LOOPBACK.test(u), 'Must be an https:// URL.');

const graphConfig = z.object({
  tenantId: z.string().trim().min(1).max(100),
  clientId: z.string().trim().min(1).max(100),
  /** Mailbox to send as (user principal name or shared mailbox). */
  sender: z.email(),
});

const smtpConfig = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  /** "tls" = implicit TLS (465), "starttls" = upgrade (587). Plain-text SMTP is not offered. */
  security: z.enum(['tls', 'starttls']),
  authMode: z.enum(SMTP_AUTH_MODES),
  username: z.string().trim().max(254).nullable().optional(),
  /** For microsoft_oauth2: Entra ID app used for SMTP AUTH XOAUTH2. */
  tenantId: z.string().trim().max(100).nullable().optional(),
  clientId: z.string().trim().max(100).nullable().optional(),
  from: z.email(),
  fromName: z.string().trim().max(100).nullable().optional(),
});

const webhookConfig = z.object({ url: https });

/** Channel definition. `secret` (client secret, SMTP password, webhook URL token or signing secret) is write-only. */
export const channelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email_graph'), name: z.string().trim().min(2).max(80), enabled: z.boolean().default(true), config: graphConfig, secret: z.string().min(1).max(4096).optional() }),
  z.object({ type: z.literal('email_smtp'), name: z.string().trim().min(2).max(80), enabled: z.boolean().default(true), config: smtpConfig, secret: z.string().min(1).max(4096).optional() }),
  z.object({ type: z.literal('teams_webhook'), name: z.string().trim().min(2).max(80), enabled: z.boolean().default(true), config: z.object({}).default({}), secret: https.optional() }),
  z.object({ type: z.literal('slack_webhook'), name: z.string().trim().min(2).max(80), enabled: z.boolean().default(true), config: z.object({}).default({}), secret: https.optional() }),
  z.object({ type: z.literal('webhook'), name: z.string().trim().min(2).max(80), enabled: z.boolean().default(true), config: webhookConfig, secret: z.string().min(16).max(4096).optional() }),
]);
export type ChannelInput = z.infer<typeof channelSchema>;

export interface ChannelDto {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  /** Non-secret settings. */
  config: Record<string, unknown>;
  secretConfigured: boolean;
  secretHint: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const channelTestSchema = z.object({ to: z.email().optional() });

// ---------------------------------------------------------------- notification rules

export const NOTIFICATION_EVENTS = ['ticket_created', 'ticket_reopened', 'sla_breached', 'scan_failed', 'weekly_digest'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  ticket_created: 'New ticket',
  ticket_reopened: 'Ticket reopened',
  sla_breached: 'SLA breached',
  scan_failed: 'Scan failed',
  weekly_digest: 'Weekly digest (Mondays 07:00 UTC)',
};

export const notificationRuleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  enabled: z.boolean().default(true),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1),
  /** Ticket events only fire at or above this severity. */
  minSeverity: z.enum(SEVERITIES).default('high'),
  /** Limit to repositories of these teams; empty means all repositories. */
  teamIds: z.array(z.uuid()).max(100).default([]),
  channelIds: z.array(z.uuid()).min(1).max(20),
  /** Extra email recipients for email channels. */
  recipients: z.array(z.email()).max(50).default([]),
  /** Also email the repository's notification recipients. */
  includeRepoRecipients: z.boolean().default(true),
});
export type NotificationRuleInput = z.infer<typeof notificationRuleSchema>;

export interface NotificationRuleDto extends NotificationRuleInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- Jira

export const jiraSettingsSchema = z.object({
  enabled: z.boolean(),
  deployment: z.enum(['cloud', 'datacenter']),
  baseUrl: https,
  /** Jira Cloud: the account email that owns the API token. Data Center: leave empty (personal access token). */
  email: z.email().nullable().optional(),
  /** Write-only. Omit to keep the stored token. */
  token: z.string().min(1).max(4096).optional(),
  defaultIssueType: z.string().trim().min(1).max(60),
  /** Optional label added to every issue Argus creates. */
  label: z.string().trim().max(40).nullable().optional(),
});
export type JiraSettingsInput = z.infer<typeof jiraSettingsSchema>;

export interface JiraSettingsDto extends Omit<JiraSettingsInput, 'token'> {
  tokenConfigured: boolean;
  tokenHint: string | null;
}

export interface ConnectionTestDto {
  ok: boolean;
  message: string;
}
