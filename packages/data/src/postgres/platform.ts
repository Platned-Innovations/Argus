import { randomUUID } from 'node:crypto';
import { type Kysely, type Selectable, sql } from 'kysely';
import { type CredentialKind, type CredentialSource, type Permission } from '@argus/shared';
import { type ApiToken, type Credential, type CredentialListFilter, type CredentialPatch, type NewApiToken, type NewCredential } from '../platform-models';
import { type ApiTokenRepo, type CredentialRepo } from '../store';
import { type ApiTokensTable, type CredentialsTable, type Database } from './schema';

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

function toCredential(r: Selectable<CredentialsTable>): Credential {
  return { ...r, kind: r.kind as CredentialKind, source: r.source as CredentialSource, notifyEmails: r.notifyEmails ?? [] };
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export class PgCredentialRepo implements CredentialRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewCredential): Promise<Credential> {
    const id = randomUUID();
    const now = new Date();
    await this.db
      .insertInto('credentials')
      .values({ ...input, id, notifyEmails: JSON.stringify(input.notifyEmails), lastNoticeDays: null, createdAt: now, updatedAt: now })
      .execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<Credential | null> {
    const r = await this.db.selectFrom('credentials').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toCredential(r) : null;
  }

  async list(f: CredentialListFilter): Promise<{ items: Credential[]; total: number }> {
    if (f.visibleTeamIds && f.visibleTeamIds.length === 0) return { items: [], total: 0 };
    let q = this.db.selectFrom('credentials');
    if (f.visibleTeamIds) q = q.where('teamId', 'in', f.visibleTeamIds);
    if (f.teamId) q = q.where('teamId', '=', f.teamId);
    if (f.archived !== undefined) q = q.where('archived', '=', f.archived);
    if (f.expiresBefore) q = q.where('expiresAt', '<', f.expiresBefore);
    if (f.search) {
      const p = likePattern(f.search);
      q = q.where((eb) => eb.or([eb('name', 'ilike', p), eb('system', 'ilike', p), eb('owner', 'ilike', p)]));
    }
    const [count, rows] = await Promise.all([q.select(sql<number>`count(*)::int`.as('n')).executeTakeFirst(), q.selectAll().orderBy('expiresAt').orderBy('id').offset(f.offset).limit(f.limit).execute()]);
    return { items: rows.map(toCredential), total: count?.n ?? 0 };
  }

  async update(id: string, patch: CredentialPatch): Promise<Credential | null> {
    const { notifyEmails, ...rest } = patch;
    await this.db
      .updateTable('credentials')
      .set({ ...rest, ...(notifyEmails !== undefined ? { notifyEmails: JSON.stringify(notifyEmails) } : {}), updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    return Number((await this.db.deleteFrom('credentials').where('id', '=', id).executeTakeFirst()).numDeletedRows) > 0;
  }

  async listBySource(source: Credential['source']): Promise<Credential[]> {
    return (await this.db.selectFrom('credentials').selectAll().where('source', '=', source).execute()).map(toCredential);
  }
}
