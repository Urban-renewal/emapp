/**
 * Proposals query-key builders — a PLAIN module (NO `'use client'`) so BOTH the
 * client hook (`use-proposals.ts`) AND a future RSC prefetch can import + call
 * it without crossing Next's client/server boundary (the `use-notifications.keys`
 * discipline). Single source of truth so server/client keys can never drift.
 */

export const PROPOSALS_KEY = ['proposals'] as const;

/** Shape: `['proposals', 'list', query, locale]`. `query` is the LITERAL object
 *  the hook passes (`{ limit, cursor, kind }`); `locale` is the narrowed
 *  `'he' | 'en'`. TanStack `hashKey` drops `undefined`, so `{ limit: 25 }` and
 *  `{ limit: 25, cursor: undefined }` hash identically. */
export function proposalsListQueryKey(
  query: { limit?: number; cursor?: string; kind?: string },
  locale: 'he' | 'en',
) {
  return [...PROPOSALS_KEY, 'list', query, locale] as const;
}

/** Shape: `['proposals', 'pending-count', { kind }]` — the constant-time
 *  inbox-header count (locale-independent; it's a number). `kind` mirrors the
 *  active list facet so the count + feed stay kind-aligned (TanStack `hashKey`
 *  drops `undefined`, so the no-filter key hashes as `{}`). Nested under
 *  `PROPOSALS_KEY` so an approve/reject `invalidateQueries({ queryKey:
 *  PROPOSALS_KEY })` refreshes every count variant too (one source of truth: the
 *  count + the list move together). */
export function proposalsPendingCountQueryKey(query: { kind?: string } = {}) {
  return [...PROPOSALS_KEY, 'pending-count', query] as const;
}
