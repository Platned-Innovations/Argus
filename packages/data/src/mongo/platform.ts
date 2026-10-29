import { randomUUID } from 'node:crypto';
import { type Collection, type Db } from 'mongodb';
import { type ApiToken, type NewApiToken } from '../platform-models';
import { type ApiTokenRepo } from '../store';

export type ApiTokenDoc = Omit<ApiToken, 'id'> & { _id: string };

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

export async function bootstrapPlatformIndexes(db: Db): Promise<void> {
  await db.collection('api_tokens').createIndexes([
    { key: { tokenHash: 1 }, unique: true, name: 'token_hash_unique' },
    { key: { userId: 1 }, name: 'user' },
  ]);
}
