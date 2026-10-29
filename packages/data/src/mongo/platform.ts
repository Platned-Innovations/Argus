import { randomUUID } from 'node:crypto';
import { type Collection, type Db, type Filter } from 'mongodb';
import { type ApiToken, type Credential, type CredentialListFilter, type CredentialPatch, type Invite, type NewApiToken, type NewCredential, type NewInvite, type NewSavedView, type SavedView } from '../platform-models';
import { type ApiTokenRepo, type CredentialRepo, type InviteRepo, type SavedViewRepo } from '../store';

export type ApiTokenDoc = Omit<ApiToken, 'id'> & { _id: string };
export type CredentialDoc = Omit<Credential, 'id'> & { _id: string };
export type SavedViewDoc = Omit<SavedView, 'id'> & { _id: string; nameLower: string };
export type InviteDoc = Omit<Invite, 'id'> & { _id: string };

function strip<T extends { _id: string }>(d: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = d;
  return { id: _id, ...rest };
}

export class MongoApiTokenRepo implements ApiTokenRepo {
  constructor(private readonly col: Collection<ApiTokenDoc>) {}

  async create(input: NewApiToken): Promise<ApiToken> {
    const doc: ApiTokenDoc = { ...input, _id: randomUUID(), lastUsedAt: null, lastUsedIp: null, revokedAt: null, createdAt: new Date() };
    await this.col.insertOne(doc);
    return strip(doc);
  }

  async findById(id: string): Promise<ApiToken | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? strip(d) : null;
  }

  async findByHash(tokenHash: string): Promise<ApiToken | null> {
    const d = await this.col.findOne({ tokenHash });
    return d ? strip(d) : null;
  }

  async listForUser(userId: string): Promise<ApiToken[]> {
    return (await this.col.find({ userId }).sort({ createdAt: -1, _id: 1 }).toArray()).map(strip);
  }

  async listAll(): Promise<ApiToken[]> {
    return (await this.col.find().sort({ createdAt: -1, _id: 1 }).toArray()).map(strip);
  }

  async touch(id: string, at: Date, ip: string | null): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { lastUsedAt: at, lastUsedIp: ip } });
  }

  async revoke(id: string): Promise<boolean> {
    return (await this.col.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } })).modifiedCount > 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    return (await this.col.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } })).modifiedCount;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MongoCredentialRepo implements CredentialRepo {
  constructor(private readonly col: Collection<CredentialDoc>) {}

  async create(input: NewCredential): Promise<Credential> {
    const now = new Date();
    const doc: CredentialDoc = { ...input, _id: randomUUID(), lastNoticeDays: null, createdAt: now, updatedAt: now };
    await this.col.insertOne(doc);
    return strip(doc);
  }

  async findById(id: string): Promise<Credential | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? strip(d) : null;
  }

  async list(f: CredentialListFilter): Promise<{ items: Credential[]; total: number }> {
    if (f.visibleTeamIds && f.visibleTeamIds.length === 0) return { items: [], total: 0 };
    const and: Filter<CredentialDoc>[] = [];
    if (f.visibleTeamIds) and.push({ teamId: { $in: f.visibleTeamIds } });
    if (f.teamId) and.push({ teamId: f.teamId });
    if (f.archived !== undefined) and.push({ archived: f.archived });
    if (f.expiresBefore) and.push({ expiresAt: { $lt: f.expiresBefore } });
    if (f.search) {
      const re = new RegExp(escapeRegex(f.search), 'i');
      and.push({ $or: [{ name: re }, { system: re }, { owner: re }] });
    }
    const q: Filter<CredentialDoc> = and.length ? { $and: and } : {};
    const [total, docs] = await Promise.all([this.col.countDocuments(q), this.col.find(q).sort({ expiresAt: 1, _id: 1 }).skip(f.offset).limit(f.limit).toArray()]);
    return { items: docs.map(strip), total };
  }

  async update(id: string, patch: CredentialPatch): Promise<Credential | null> {
    const d = await this.col.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
    return d ? strip(d) : null;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount > 0;
  }

  async listBySource(source: Credential['source']): Promise<Credential[]> {
    return (await this.col.find({ source }).toArray()).map(strip);
  }
}

function toView(d: SavedViewDoc): SavedView {
  const { _id, nameLower: _lower, ...rest } = d;
  return { id: _id, ...rest };
}

export class MongoSavedViewRepo implements SavedViewRepo {
  constructor(private readonly col: Collection<SavedViewDoc>) {}

  async create(input: NewSavedView): Promise<SavedView> {
    const doc: SavedViewDoc = { ...input, _id: randomUUID(), nameLower: input.name.toLowerCase(), createdAt: new Date() };
    await this.col.insertOne(doc);
    return toView(doc);
  }

  async findById(id: string): Promise<SavedView | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? toView(d) : null;
  }

  async listVisible(userId: string, page: SavedView['page']): Promise<SavedView[]> {
    return (await this.col.find({ page, $or: [{ userId }, { shared: true }] }).sort({ nameLower: 1, _id: 1 }).toArray()).map(toView);
  }

  async countForUser(userId: string, page: SavedView['page']): Promise<number> {
    return this.col.countDocuments({ userId, page });
  }

  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount > 0;
  }
}

export async function bootstrapPlatformIndexes(db: Db): Promise<void> {
  await db.collection('saved_views').createIndexes([
    { key: { userId: 1, page: 1 }, name: 'user_page' },
    { key: { page: 1, shared: 1 }, name: 'page_shared' },
  ]);
  await db.collection('credentials').createIndexes([
    { key: { source: 1, externalId: 1 }, unique: true, name: 'source_external_unique', partialFilterExpression: { externalId: { $type: 'string' } } },
    { key: { archived: 1, expiresAt: 1 }, name: 'archived_expiry' },
  ]);
  await db.collection('invites').createIndexes([{ key: { tokenHash: 1 }, unique: true, name: 'token_hash_unique' }]);
  await db.collection('api_tokens').createIndexes([
    { key: { tokenHash: 1 }, unique: true, name: 'token_hash_unique' },
    { key: { userId: 1 }, name: 'user' },
  ]);
}

export class MongoInviteRepo implements InviteRepo {
  constructor(private readonly col: Collection<InviteDoc>) {}

  async create(input: NewInvite): Promise<Invite> {
    const doc: InviteDoc = { ...input, _id: randomUUID(), uses: 0, createdAt: new Date(), lastUsedAt: null, revokedAt: null };
    await this.col.insertOne(doc);
    return strip(doc);
  }

  async findById(id: string): Promise<Invite | null> {
    const d = await this.col.findOne({ _id: id });
    return d ? strip(d) : null;
  }

  async findByHash(tokenHash: string): Promise<Invite | null> {
    const d = await this.col.findOne({ tokenHash });
    return d ? strip(d) : null;
  }

  async list(): Promise<Invite[]> {
    return (await this.col.find().sort({ createdAt: -1, _id: 1 }).toArray()).map(strip);
  }

  async consume(id: string, now: Date): Promise<boolean> {
    const res = await this.col.updateOne({ _id: id, revokedAt: null, expiresAt: { $gt: now }, $expr: { $lt: ['$uses', '$maxUses'] } }, { $inc: { uses: 1 }, $set: { lastUsedAt: now } });
    return res.modifiedCount > 0;
  }

  async release(id: string): Promise<void> {
    await this.col.updateOne({ _id: id, uses: { $gt: 0 } }, { $inc: { uses: -1 } });
  }

  async revoke(id: string): Promise<boolean> {
    return (await this.col.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } })).modifiedCount > 0;
  }
}
