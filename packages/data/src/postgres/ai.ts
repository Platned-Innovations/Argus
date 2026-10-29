import { randomUUID } from 'node:crypto';
import { type Kysely, type Selectable, sql } from 'kysely';
import { type AiProvider, type AiSubjectType, type AiUseCase } from '@argus/shared';
import { type AiInsight, type AiUsageSummaryRecord, type NewAiInsight, type NewAiUsage } from '../ai-models';
import { type AiInsightRepo, type AiUsageRepo } from '../store';
import { type AiInsightsTable, type Database } from './schema';

type Db = Kysely<Database>;

function toInsight(r: Selectable<AiInsightsTable>): AiInsight {
  return { ...r, subjectType: r.subjectType as AiSubjectType, useCase: r.useCase as AiUseCase, provider: r.provider as AiProvider };
}

export class PgAiUsageRepo implements AiUsageRepo {
  constructor(private readonly db: Db) {}

  async record(u: NewAiUsage): Promise<void> {
    await this.db
      .insertInto('aiUsage')
      .values({ ...u, id: randomUUID(), at: u.at ?? new Date() })
      .execute();
  }

  async summary(from: Date, to: Date): Promise<AiUsageSummaryRecord[]> {
    const rows = await this.db
      .selectFrom('aiUsage')
      .select([
        'provider',
        'model',
        'useCase',
        sql<number>`count(*)::int`.as('requests'),
        sql<number>`(count(*) filter (where outcome <> 'ok'))::int`.as('failures'),
        sql<number>`coalesce(sum(input_tokens), 0)::float8`.as('inputTokens'),
        sql<number>`coalesce(sum(output_tokens), 0)::float8`.as('outputTokens'),
        sql<number>`coalesce(sum(cost_usd), 0)::float8`.as('costUsd'),
      ])
      .where('at', '>=', from)
      .where('at', '<', to)
      .groupBy(['provider', 'model', 'useCase'])
      .orderBy('provider')
      .orderBy('model')
      .orderBy('useCase')
      .execute();
    return rows.map((r) => ({ ...r, provider: r.provider as AiProvider, useCase: r.useCase as AiUseCase }));
  }

  async totalCost(from: Date, to: Date): Promise<number> {
    const r = await this.db
      .selectFrom('aiUsage')
      .select(sql<number>`coalesce(sum(cost_usd), 0)::float8`.as('total'))
      .where('at', '>=', from)
      .where('at', '<', to)
      .executeTakeFirst();
    return r?.total ?? 0;
  }
}

export class PgAiInsightRepo implements AiInsightRepo {
  constructor(private readonly db: Db) {}

  async put(i: NewAiInsight): Promise<AiInsight> {
    const values = { ...i, output: JSON.stringify(i.output), createdAt: new Date() };
    const r = await this.db
      .insertInto('aiInsights')
      .values({ ...values, id: randomUUID() })
      .onConflict((oc) => oc.columns(['subjectType', 'subjectId', 'useCase']).doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toInsight(r);
  }

  async find(subjectType: AiSubjectType, subjectId: string, useCase: AiUseCase): Promise<AiInsight | null> {
    const r = await this.db.selectFrom('aiInsights').selectAll().where('subjectType', '=', subjectType).where('subjectId', '=', subjectId).where('useCase', '=', useCase).executeTakeFirst();
    return r ? toInsight(r) : null;
  }

  async listForSubjects(subjectType: AiSubjectType, subjectIds: string[]): Promise<AiInsight[]> {
    if (subjectIds.length === 0) return [];
    return (await this.db.selectFrom('aiInsights').selectAll().where('subjectType', '=', subjectType).where('subjectId', 'in', subjectIds).execute()).map(toInsight);
  }
}
