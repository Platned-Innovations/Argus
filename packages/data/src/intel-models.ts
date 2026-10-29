import { type AdvisoryInput, type AdvisorySource, type AiProvider, type IntelItemStatus } from '@argus/shared';

/** A security news feed (RSS or Atom). */
export interface IntelSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  intervalMinutes: number;
  lastFetchedAt: Date | null;
  lastError: string | null;
  lastNewItems: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewIntelSource = Pick<IntelSource, 'name' | 'url' | 'enabled' | 'intervalMinutes'>;
export type IntelSourcePatch = Partial<Omit<IntelSource, 'id' | 'createdAt' | 'updatedAt'>>;

export interface IntelExtraction {
  provider: AiProvider;
  model: string;
  confidence: number;
  rationale: string;
  at: Date;
}

/** One entry of a news feed, and where it is in the review workflow. */
export interface IntelItem {
  id: string;
  sourceId: string;
  /** Feed guid or link, hashed: identifies the entry across fetches. */
  guid: string;
  title: string;
  link: string | null;
  publishedAt: Date | null;
  /** Plain text, capped. */
  summary: string;
  status: IntelItemStatus;
  candidates: AdvisoryInput[];
  extraction: IntelExtraction | null;
  error: string | null;
  advisoryIds: string[];
  reviewedBy: string | null;
  reviewedAt: Date | null;
  fetchedAt: Date;
}

export type NewIntelItem = Pick<IntelItem, 'sourceId' | 'guid' | 'title' | 'link' | 'publishedAt' | 'summary'>;
export type IntelItemPatch = Partial<Pick<IntelItem, 'status' | 'candidates' | 'extraction' | 'error' | 'advisoryIds' | 'reviewedBy' | 'reviewedAt'>>;

export interface IntelItemListFilter {
  statuses?: IntelItemStatus[];
  sourceId?: string;
  /** Matches the title. */
  search?: string;
  offset: number;
  limit: number;
}

/** An advisory curated in Argus (approved from news, or entered by hand), matched like OSV advisories. */
export interface Advisory extends AdvisoryInput {
  id: string;
  /** e.g. ARGUS-2026-0001 */
  key: string;
  source: AdvisorySource;
  sourceItemId: string | null;
  withdrawn: boolean;
  autoApproved: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewAdvisory = Omit<Advisory, 'id' | 'createdAt' | 'updatedAt'>;

export interface AdvisoryListFilter {
  search?: string;
  withdrawn?: boolean;
  offset: number;
  limit: number;
}
