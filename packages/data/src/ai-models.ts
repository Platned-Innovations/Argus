import { type AiProvider, type AiSubjectType, type AiUseCase } from '@argus/shared';

export type AiOutcome = 'ok' | 'error' | 'invalid_output';

/** One AI request: who asked, for what, and what it cost. Prompts and outputs are never stored here. */
export interface AiUsage {
  id: string;
  at: Date;
  provider: AiProvider;
  model: string;
  useCase: AiUseCase;
  userId: string | null;
  repoId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: AiOutcome;
}

export type NewAiUsage = Omit<AiUsage, 'id' | 'at'> & { at?: Date };

export interface AiUsageSummaryRecord {
  provider: AiProvider;
  model: string;
  useCase: AiUseCase;
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** The latest validated AI output for a subject and use case (e.g. remediation advice for a ticket). */
export interface AiInsight {
  id: string;
  subjectType: AiSubjectType;
  subjectId: string;
  repoId: string;
  useCase: AiUseCase;
  provider: AiProvider;
  model: string;
  output: Record<string, unknown>;
  redactions: number;
  createdBy: string | null;
  createdAt: Date;
}

export type NewAiInsight = Omit<AiInsight, 'id' | 'createdAt'>;
