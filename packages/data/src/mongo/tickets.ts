import { randomUUID } from 'node:crypto';
import { type Collection, type Db, type Filter } from 'mongodb';
import { ACTIVE_TICKET_STATUSES, type Severity, SEVERITIES } from '@argus/shared';
import { type Page } from '../models';
import { type ChannelRepo, type CounterRepo, type NotificationRuleRepo, type TicketRepo } from '../store';
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
  type TicketListFilter,
  type TicketPatch,
  type TicketSummaryRecord,
} from '../tickets-models';

export type TicketDoc = Omit<Ticket, 'id'> & { _id: string };
export type TicketEventDoc = Omit<TicketEvent, 'id'> & { _id: string };
export type CounterDoc = { _id: string; value: number };
export type ChannelDoc = Omit<Channel, 'id'> & { _id: string };
export type RuleDoc = Omit<NotificationRule, 'id'> & { _id: string };

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function strip<T extends { _id: string }>(d: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = d;
  return { id: _id, ...rest };
}

export class MongoTicketRepo implements TicketRepo {
  constructor(
    private readonly col: Collection<TicketDoc>,
    private readonly events: Collection<TicketEventDoc>,
  ) {}

  async create(input: NewTicket): Promise<Ticket> {
    const now = new Date();
    const doc: TicketDoc = { ...input, _id: randomUUID(), createdAt: now, updatedAt: now, lastActivityAt: now };
    await this.col.insertOne(doc);
    return strip(doc);
  }

  async findById(id: string): Promise<Ticket | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? strip(d) : null;
  }

  async listForRepo(repoId: string): Promise<Ticket[]> {
    return (await this.col.find({ repoId }).toArray()).map(strip);
  }

  async update(id: string, patch: TicketPatch): Promise<Ticket | null> {
    const now = new Date();
    const d = await this.col.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: now, lastActivityAt: patch.lastActivityAt ?? now } }, { returnDocument: 'after' });
    return d ? strip(d) : null;
  }

  async list(f: TicketListFilter): Promise<Page<Ticket>> {
    if (f.visibleTeamIds && f.visibleTeamIds.length === 0) return { items: [], total: 0 };
    const and: Filter<TicketDoc>[] = [];
    if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
    if (f.severities?.length) and.push({ severity: { $in: f.severities } });
    if (f.repoId) and.push({ repoId: f.repoId });
    if (f.scanner) and.push({ scanner: f.scanner });
    if (f.ids) and.push({ _id: { $in: f.ids } });
    if (f.assigneeId === null) and.push({ assigneeId: null });
    else if (f.assigneeId) and.push({ assigneeId: f.assigneeId });
    const breached: Filter<TicketDoc> = { status: { $in: ACTIVE_TICKET_STATUSES }, dueAt: { $lt: f.now } };
    if (f.slaBreached === true) and.push(breached);
    if (f.slaBreached === false) and.push({ $nor: [breached] });
    if (f.visibleTeamIds) and.push({ teamId: { $in: f.visibleTeamIds } });
    if (f.search) {
      const re = new RegExp(escapeRegex(f.search), 'i');
      and.push({ $or: [{ key: re }, { title: re }, { labels: re }] });
    }
    const q: Filter<TicketDoc> = and.length ? { $and: and } : {};
    const [total, docs] = await Promise.all([this.col.countDocuments(q), this.col.find(q).sort({ riskScore: -1, createdAt: -1, _id: 1 }).skip(f.offset).limit(f.limit).toArray()]);
    return { items: docs.map(strip), total };
  }

  async summary(f: { visibleTeamIds?: string[]; userId: string; now: Date }): Promise<TicketSummaryRecord> {
    const out: TicketSummaryRecord = { active: 0, bySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>, slaBreached: 0, assignedTo: 0, unassigned: 0 };
    if (f.visibleTeamIds && f.visibleTeamIds.length === 0) return out;
    const match: Filter<TicketDoc> = { status: { $in: ACTIVE_TICKET_STATUSES } };
    if (f.visibleTeamIds) match.teamId = { $in: f.visibleTeamIds };
    const rows = await this.col
      .aggregate<{ _id: Severity; n: number; breached: number; mine: number; unassigned: number }>([
        { $match: match },
        {
          $group: {
            _id: '$severity',
            n: { $sum: 1 },
            breached: { $sum: { $cond: [{ $and: [{ $ne: ['$dueAt', null] }, { $lt: ['$dueAt', f.now] }] }, 1, 0] } },
            mine: { $sum: { $cond: [{ $eq: ['$assigneeId', f.userId] }, 1, 0] } },
            unassigned: { $sum: { $cond: [{ $eq: ['$assigneeId', null] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    for (const r of rows) {
      out.bySeverity[r._id] = r.n;
      out.active += r.n;
      out.slaBreached += r.breached;
      out.assignedTo += r.mine;
      out.unassigned += r.unassigned;
    }
    return out;
  }

  async findNewlyOverdue(now: Date, limit: number): Promise<Ticket[]> {
    return (await this.col.find({ status: { $in: ACTIVE_TICKET_STATUSES }, dueAt: { $lt: now }, slaBreachedAt: null }).sort({ dueAt: 1 }).limit(limit).toArray()).map(strip);
  }

  async listJiraLinked(limit: number): Promise<Ticket[]> {
    return (await this.col.find({ jira: { $ne: null }, status: { $ne: 'closed' } }).sort({ updatedAt: 1 }).limit(limit).toArray()).map(strip);
  }

  async setTeamForRepo(repoId: string, teamId: string | null): Promise<void> {
    await this.col.updateMany({ repoId }, { $set: { teamId } });
  }

  async addEvent(e: NewTicketEvent): Promise<TicketEvent> {
    const event: TicketEvent = { ...e, id: randomUUID(), createdAt: e.createdAt ?? new Date() };
    const { id, ...rest } = event;
    await this.events.insertOne({ _id: id, ...rest });
    return event;
  }

  async listEvents(ticketId: string): Promise<TicketEvent[]> {
    return (await this.events.find({ ticketId }).sort({ createdAt: 1, _id: 1 }).toArray()).map(strip);
  }
}

export class MongoCounterRepo implements CounterRepo {
  constructor(private readonly col: Collection<CounterDoc>) {}

  async next(name: string): Promise<number> {
    const d = await this.col.findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
    return d!.value;
  }
}

export class MongoChannelRepo implements ChannelRepo {
  constructor(private readonly col: Collection<ChannelDoc>) {}

  async create(input: NewChannel): Promise<Channel> {
    const now = new Date();
    const doc: ChannelDoc = { ...input, _id: randomUUID(), lastUsedAt: null, lastError: null, createdAt: now, updatedAt: now };
    await this.col.insertOne(doc);
    return strip(doc);
  }

  async findById(id: string): Promise<Channel | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? strip(d) : null;
  }

  async list(): Promise<Channel[]> {
    return (await this.col.find().sort({ name: 1 }).toArray()).map(strip);
  }

  async update(id: string, patch: ChannelPatch): Promise<Channel | null> {
    const d = await this.col.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
    return d ? strip(d) : null;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount > 0;
  }
}

export class MongoNotificationRuleRepo implements NotificationRuleRepo {
  constructor(private readonly col: Collection<RuleDoc>) {}

  async create(input: NewNotificationRule): Promise<NotificationRule> {
    const now = new Date();
    const doc: RuleDoc = { ...input, _id: randomUUID(), createdAt: now, updatedAt: now };
    await this.col.insertOne(doc);
    return strip(doc);
  }

  async findById(id: string): Promise<NotificationRule | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? strip(d) : null;
  }

  async list(): Promise<NotificationRule[]> {
    return (await this.col.find().sort({ name: 1 }).toArray()).map(strip);
  }

  async update(id: string, patch: Partial<NewNotificationRule>): Promise<NotificationRule | null> {
    const d = await this.col.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
    return d ? strip(d) : null;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount > 0;
  }
}

export async function bootstrapTicketIndexes(db: Db): Promise<void> {
  await db.collection('tickets').createIndexes([
    { key: { repoId: 1, groupKey: 1 }, unique: true, name: 'repo_group_unique' },
    { key: { key: 1 }, unique: true, name: 'key_unique' },
    { key: { status: 1, riskScore: -1 }, name: 'status_score' },
    { key: { teamId: 1, status: 1 }, name: 'team_status' },
    { key: { assigneeId: 1, status: 1 }, name: 'assignee_status' },
    { key: { status: 1, dueAt: 1 }, name: 'status_due' },
  ]);
  await db.collection('ticket_events').createIndexes([{ key: { ticketId: 1, createdAt: 1 }, name: 'ticket_created' }]);
  await db.collection('findings').createIndexes([{ key: { ticketId: 1 }, name: 'ticket' }]);
}
