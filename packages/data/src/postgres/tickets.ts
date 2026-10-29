import { randomUUID } from 'node:crypto';
import { type ExpressionBuilder, type Kysely, type Selectable, sql } from 'kysely';
import { ACTIVE_TICKET_STATUSES, type ChannelType, type NotificationEvent, type ScannerName, type Severity, SEVERITIES, type TicketEventType, type TicketStatus } from '@argus/shared';
import { type Page } from '../models';
import { type CounterRepo, type ChannelRepo, type NotificationRuleRepo, type TicketRepo } from '../store';
import {
  type Channel,
  type ChannelPatch,
  type NewChannel,
  type NewNotificationRule,
  type NewTicket,
  type NewTicketEvent,
  type NotificationRule,
  type Ticket,
  type TicketEvent,
  type TicketJiraRecord,
  type TicketListFilter,
  type TicketPatch,
  type TicketSummaryRecord,
} from '../tickets-models';
import { type Database, type NotificationChannelsTable, type NotificationRulesTable, type TicketsTable } from './schema';

type Db = Kysely<Database>;
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function toTicket(r: Selectable<TicketsTable>): Ticket {
  const jira = r.jira as (Omit<TicketJiraRecord, 'syncedAt'> & { syncedAt: string | null }) | null;
  return {
    ...r,
    scanner: r.scanner as ScannerName,
    severity: r.severity as Severity,
    status: r.status as TicketStatus,
    watcherIds: r.watcherIds ?? [],
    labels: r.labels ?? [],
    findingIds: r.findingIds ?? [],
    jira: jira ? { ...jira, syncedAt: jira.syncedAt ? new Date(jira.syncedAt) : null } : null,
  };
}

/** jsonb columns must be written as JSON strings. */
function ticketColumns(p: TicketPatch) {
  const { watcherIds, labels, findingIds, jira, ...rest } = p;
  return {
    ...rest,
    ...(watcherIds !== undefined ? { watcherIds: JSON.stringify(watcherIds) } : {}),
    ...(labels !== undefined ? { labels: JSON.stringify(labels) } : {}),
    ...(findingIds !== undefined ? { findingIds: JSON.stringify(findingIds) } : {}),
    ...(jira !== undefined ? { jira: json(jira) } : {}),
  };
}

export class PgTicketRepo implements TicketRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewTicket): Promise<Ticket> {
    const now = new Date();
    const id = randomUUID();
    await this.db
      .insertInto('tickets')
      .values({ ...(ticketColumns(input) as Record<string, unknown>), id, key: input.key, repoId: input.repoId, sourceId: input.sourceId, groupKey: input.groupKey, createdAt: now, updatedAt: now, lastActivityAt: now } as never)
      .execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<Ticket | null> {
    const r = await this.db.selectFrom('tickets').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toTicket(r) : null;
  }

  async listForRepo(repoId: string): Promise<Ticket[]> {
    return (await this.db.selectFrom('tickets').selectAll().where('repoId', '=', repoId).execute()).map(toTicket);
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket | null> {
    const now = new Date();
    await this.db
      .updateTable('tickets')
      .set({ ...(ticketColumns(patch) as Record<string, unknown>), updatedAt: now, lastActivityAt: patch.lastActivityAt ?? now } as never)
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async list(f: TicketListFilter): Promise<Page<Ticket>> {
    if (f.visibleTeamIds && f.visibleTeamIds.length === 0) return { items: [], total: 0 };
    let q = this.db.selectFrom('tickets');
    if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
    if (f.severities?.length) q = q.where('severity', 'in', f.severities);
    if (f.repoId) q = q.where('repoId', '=', f.repoId);
    if (f.scanner) q = q.where('scanner', '=', f.scanner);
    if (f.ids) q = f.ids.length ? q.where('id', 'in', f.ids) : q.where(sql<boolean>`false`);
    if (f.assigneeId === null) q = q.where('assigneeId', 'is', null);
    else if (f.assigneeId) q = q.where('assigneeId', '=', f.assigneeId);
    if (f.slaBreached !== undefined) {
      const breached = (eb: ExpressionBuilder<Database, 'tickets'>) => eb.and([eb('status', 'in', ACTIVE_TICKET_STATUSES), eb('dueAt', '<', f.now)]);
      q = f.slaBreached ? q.where(breached) : q.where((eb) => eb.not(breached(eb)));
    }
    if (f.visibleTeamIds) q = q.where('teamId', 'in', f.visibleTeamIds);
    if (f.search) {
      const p = likePattern(f.search);
      q = q.where((eb) => eb.or([eb('key', 'ilike', p), eb('title', 'ilike', p), eb(sql`labels::text`, 'ilike', p)]));
    }
    const [{ total }, rows] = await Promise.all([
      q.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow(),
      q.selectAll().orderBy('riskScore', 'desc').orderBy('createdAt', 'desc').orderBy('id').offset(f.offset).limit(f.limit).execute(),
    ]);
    return { items: rows.map(toTicket), total };
  }

  async summary(f: { visibleTeamIds?: string[]; userId: string | null; now: Date }): Promise<TicketSummaryRecord> {
    const out: TicketSummaryRecord = { active: 0, bySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>, slaBreached: 0, assignedTo: 0, unassigned: 0 };
    if (f.visibleTeamIds && f.visibleTeamIds.length === 0) return out;
    let q = this.db.selectFrom('tickets').where('status', 'in', ACTIVE_TICKET_STATUSES);
    if (f.visibleTeamIds) q = q.where('teamId', 'in', f.visibleTeamIds);
    const rows = await q
      .select([
        'severity',
        sql<number>`count(*)::int`.as('n'),
        sql<number>`count(*) filter (where due_at < ${f.now})::int`.as('breached'),
        // A non-uuid parameter here would fail the whole query on PostgreSQL, so "no user" is a constant 0.
        (f.userId ? sql<number>`count(*) filter (where assignee_id = ${f.userId})::int` : sql<number>`0`).as('mine'),
        sql<number>`count(*) filter (where assignee_id is null)::int`.as('unassigned'),
      ])
      .groupBy('severity')
      .execute();
    for (const r of rows) {
      out.bySeverity[r.severity as Severity] = r.n;
      out.active += r.n;
      out.slaBreached += r.breached;
      out.assignedTo += r.mine;
      out.unassigned += r.unassigned;
    }
    return out;
  }

  async findNewlyOverdue(now: Date, limit: number): Promise<Ticket[]> {
    const rows = await this.db
      .selectFrom('tickets')
      .selectAll()
      .where('status', 'in', ACTIVE_TICKET_STATUSES)
      .where('dueAt', '<', now)
      .where('slaBreachedAt', 'is', null)
      .orderBy('dueAt')
      .limit(limit)
      .execute();
    return rows.map(toTicket);
  }

  async listJiraLinked(limit: number): Promise<Ticket[]> {
    const rows = await this.db.selectFrom('tickets').selectAll().where('jira', 'is not', null).where('status', '!=', 'closed').orderBy('updatedAt').limit(limit).execute();
    return rows.map(toTicket);
  }

  async setTeamForRepo(repoId: string, teamId: string | null): Promise<void> {
    await this.db.updateTable('tickets').set({ teamId }).where('repoId', '=', repoId).execute();
  }

  async addEvent(e: NewTicketEvent): Promise<TicketEvent> {
    const event: TicketEvent = { ...e, id: randomUUID(), createdAt: e.createdAt ?? new Date() };
    await this.db
      .insertInto('ticketEvents')
      .values({ ...event, data: json(event.data) })
      .execute();
    return event;
  }

  async listEvents(ticketId: string): Promise<TicketEvent[]> {
    const rows = await this.db.selectFrom('ticketEvents').selectAll().where('ticketId', '=', ticketId).orderBy('createdAt').orderBy('id').execute();
    return rows.map((r) => ({ ...r, type: r.type as TicketEventType, data: r.data ?? null }));
  }
}

export class PgCounterRepo implements CounterRepo {
  constructor(private readonly db: Db) {}

  async next(name: string): Promise<number> {
    const row = await this.db
      .insertInto('counters')
      .values({ name, value: 1 })
      .onConflict((oc) => oc.column('name').doUpdateSet({ value: sql`counters.value + 1` }))
      .returning('value')
      .executeTakeFirstOrThrow();
    return Number(row.value);
  }
}

function toChannel(r: Selectable<NotificationChannelsTable>): Channel {
  return { ...r, type: r.type as ChannelType, config: r.config ?? {} };
}

export class PgChannelRepo implements ChannelRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewChannel): Promise<Channel> {
    const now = new Date();
    const c: Channel = { ...input, id: randomUUID(), lastUsedAt: null, lastError: null, createdAt: now, updatedAt: now };
    await this.db
      .insertInto('notificationChannels')
      .values({ ...c, config: JSON.stringify(c.config) })
      .execute();
    return c;
  }

  async findById(id: string): Promise<Channel | null> {
    const r = await this.db.selectFrom('notificationChannels').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toChannel(r) : null;
  }

  async list(): Promise<Channel[]> {
    return (await this.db.selectFrom('notificationChannels').selectAll().orderBy('name').execute()).map(toChannel);
  }

  async update(id: string, patch: ChannelPatch): Promise<Channel | null> {
    const { config, ...rest } = patch;
    await this.db
      .updateTable('notificationChannels')
      .set({ ...rest, ...(config !== undefined ? { config: JSON.stringify(config) } : {}), updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.deleteFrom('notificationChannels').where('id', '=', id).executeTakeFirst()).numDeletedRows > 0n;
  }
}

function toRule(r: Selectable<NotificationRulesTable>): NotificationRule {
  return { ...r, events: r.events as NotificationEvent[], minSeverity: r.minSeverity as Severity };
}

function ruleColumns(p: Partial<NewNotificationRule>) {
  const { events, teamIds, channelIds, recipients, ...rest } = p;
  return {
    ...rest,
    ...(events !== undefined ? { events: JSON.stringify(events) } : {}),
    ...(teamIds !== undefined ? { teamIds: JSON.stringify(teamIds) } : {}),
    ...(channelIds !== undefined ? { channelIds: JSON.stringify(channelIds) } : {}),
    ...(recipients !== undefined ? { recipients: JSON.stringify(recipients) } : {}),
  };
}

export class PgNotificationRuleRepo implements NotificationRuleRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewNotificationRule): Promise<NotificationRule> {
    const now = new Date();
    const id = randomUUID();
    await this.db
      .insertInto('notificationRules')
      .values({ ...(ruleColumns(input) as Record<string, unknown>), id, createdAt: now, updatedAt: now } as never)
      .execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<NotificationRule | null> {
    const r = await this.db.selectFrom('notificationRules').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toRule(r) : null;
  }

  async list(): Promise<NotificationRule[]> {
    return (await this.db.selectFrom('notificationRules').selectAll().orderBy('name').execute()).map(toRule);
  }

  async update(id: string, patch: Partial<NewNotificationRule>): Promise<NotificationRule | null> {
    await this.db
      .updateTable('notificationRules')
      .set({ ...(ruleColumns(patch) as Record<string, unknown>), updatedAt: new Date() } as never)
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.deleteFrom('notificationRules').where('id', '=', id).executeTakeFirst()).numDeletedRows > 0n;
  }
}
