import { randomUUID } from 'node:crypto';
import { type Collection, type Db } from 'mongodb';
import { type AiSubjectType, type AiUseCase } from '@argus/shared';
import { type AiInsight, type AiUsage, type AiUsageSummaryRecord, type NewAiInsight, type NewAiUsage } from '../ai-models';
import { type AiInsightRepo, type AiUsageRepo } from '../store';

export type AiUsageDoc = Omit<AiUsage, 'id'> & { _id: string };
export type AiInsightDoc = Omit<AiInsight, 'id'> & { _id: string };

function strip<T extends { _id: string }>(d: T): Omit<T, '_id'> & { id: string } {
  const { _id, ...rest } = d;
  return { id: _id, ...rest };
}

type SummaryRow = { _id: Pick<AiUsageSummaryRecord, 'provider' | 'model' | 'useCase'> } & Omit<AiUsageSummaryRecord, 'provider' | 'model' | 'useCase'>;

export class MongoAiUsageRepo implements AiUsageRepo {
  constructor(private readonly col: Collection<AiUsageDoc>) {}

  async record(u: NewAiUsage): Promise<void> {
    await this.col.insertOne({ ...u, _id: randomUUID(), at: u.at ?? new Date() });
  }

  async summary(from: Date, to: Date): Promise<AiUsageSummaryRecord[]> {
    const rows = await this.col
      .aggregate<SummaryRow>([
        { $match: { at: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { provider: '$provider', model: '$model', useCase: '$useCase' },
            requests: { $sum: 1 },
            failures: { $sum: { $cond: [{ $ne: ['$outcome', 'ok'] }, 1, 0] } },
            inputTokens: { $sum: '$inputTokens' },
            outputTokens: { $sum: '$outputTokens' },
            costUsd: { $sum: '$costUsd' },
          },
        },
        { $sort: { '_id.provider': 1, '_id.model': 1, '_id.useCase': 1 } },
      ])
      .toArray();
    return rows.map(({ _id, ...rest }) => ({ ..._id, ...rest }));
  }

  async totalCost(from: Date, to: Date): Promise<number> {
    const [r] = await this.col.aggregate<{ total: number }>([{ $match: { at: { $gte: from, $lt: to } } }, { $group: { _id: null, total: { $sum: '$costUsd' } } }]).toArray();
    return r?.total ?? 0;
  }
  async deleteBefore(before: Date): Promise<number> {
    return (await this.col.deleteMany({ at: { $lt: before } })).deletedCount;
  }

}

export class MongoAiInsightRepo implements AiInsightRepo {
  constructor(private readonly col: Collection<AiInsightDoc>) {}

  async put(i: NewAiInsight): Promise<AiInsight> {
    const d = await this.col.findOneAndUpdate(
      { subjectType: i.subjectType, subjectId: i.subjectId, useCase: i.useCase },
      { $set: { ...i, createdAt: new Date() }, $setOnInsert: { _id: randomUUID() } },
      { upsert: true, returnDocument: 'after' },
    );
    return strip(d!);
  }

  async find(subjectType: AiSubjectType, subjectId: string, useCase: AiUseCase): Promise<AiInsight | null> {
    const d = await this.col.findOne({ subjectType, subjectId, useCase });
    return d ? strip(d) : null;
  }

  async listForSubjects(subjectType: AiSubjectType, subjectIds: string[]): Promise<AiInsight[]> {
    if (subjectIds.length === 0) return [];
    return (await this.col.find({ subjectType, subjectId: { $in: subjectIds } }).toArray()).map(strip);
  }
}

export async function bootstrapAiIndexes(db: Db): Promise<void> {
  await db.collection('ai_usage').createIndexes([{ key: { at: 1 }, name: 'at' }]);
  await db.collection('ai_insights').createIndexes([
    { key: { subjectType: 1, subjectId: 1, useCase: 1 }, unique: true, name: 'subject_unique' },
    { key: { repoId: 1 }, name: 'repo' },
  ]);
}
