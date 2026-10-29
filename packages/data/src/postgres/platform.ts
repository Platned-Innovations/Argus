import { randomUUID } from 'node:crypto';
import { type Kysely, type Selectable } from 'kysely';
import { type Permission } from '@argus/shared';
import { type ApiToken, type NewApiToken } from '../platform-models';
import { type ApiTokenRepo } from '../store';
import { type ApiTokensTable, type Database } from './schema';

type Db = Kysely<Database>;

function toToken(r: Selectable<ApiTokensTable>): ApiToken {
  return { ...r, scopes: (r.scopes ?? []) as Permission[] };
}

export class PgApiTokenRepo implements ApiTokenRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewApiToken): Promise<ApiToken> {
    const id = randomUUID();
    await this.db
      .insertInto('apiTokens')
      .values({ ...input, id, scopes: JSON.stringify(input.scopes), lastUsedAt: null, lastUsedIp: null, revokedAt: null, createdAt: new Date() })
      .execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<ApiToken | null> {
    const r = await this.db.selectFrom('apiTokens').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toToken(r) : null;
  }

  async findByHash(tokenHash: string): Promise<ApiToken | null> {
    const r = await this.db.selectFrom('apiTokens').selectAll().where('tokenHash', '=', tokenHash).executeTakeFirst();
    return r ? toToken(r) : null;
  }

  async listForUser(userId: string): Promise<ApiToken[]> {
    return (await this.db.selectFrom('apiTokens').selectAll().where('userId', '=', userId).orderBy('createdAt', 'desc').orderBy('id').execute()).map(toToken);
  }

  async listAll(): Promise<ApiToken[]> {
    return (await this.db.selectFrom('apiTokens').selectAll().orderBy('createdAt', 'desc').orderBy('id').execute()).map(toToken);
  }

  async touch(id: string, at: Date, ip: string | null): Promise<void> {
    await this.db.updateTable('apiTokens').set({ lastUsedAt: at, lastUsedIp: ip }).where('id', '=', id).execute();
  }

  async revoke(id: string): Promise<boolean> {
    const res = await this.db.updateTable('apiTokens').set({ revokedAt: new Date() }).where('id', '=', id).where('revokedAt', 'is', null).executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const res = await this.db.updateTable('apiTokens').set({ revokedAt: new Date() }).where('userId', '=', userId).where('revokedAt', 'is', null).executeTakeFirst();
    return Number(res.numUpdatedRows);
  }
}
