import { z } from 'zod';

/** Lists that support saved views. */
export const SAVED_VIEW_PAGES = ['tickets', 'findings'] as const;
export type SavedViewPage = (typeof SAVED_VIEW_PAGES)[number];

/** A user may keep this many views per list. */
export const MAX_SAVED_VIEWS = 50;

export const savedViewCreateSchema = z.object({
  page: z.enum(SAVED_VIEW_PAGES),
  name: z.string().trim().min(1).max(80),
  /** The list's filters, as a URL query string (without "?"). */
  query: z.string().max(1000).refine((q) => !q.startsWith('?'), 'Leave out the leading "?".'),
  /** Shared views are visible to everyone who can see the list; the filters still apply each viewer's own access. */
  shared: z.boolean().default(false),
});
export type SavedViewCreateInput = z.infer<typeof savedViewCreateSchema>;

export const savedViewListQuerySchema = z.object({ page: z.enum(SAVED_VIEW_PAGES) });

export interface SavedViewDto {
  id: string;
  page: SavedViewPage;
  name: string;
  query: string;
  shared: boolean;
  /** Whether the current user created it (and may delete it). */
  mine: boolean;
  ownerName: string | null;
  createdAt: string;
}
