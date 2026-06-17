/**
 * Owners query-key builders — a PLAIN module (NO `'use client'`) so BOTH
 * the client hook (`use-owners.ts`) and the server RSC prefetch
 * (`owners/page.tsx`) can import AND call it. The builder previously lived
 * inline in `use-owners.ts`, but that file is `'use client'`, so a Server
 * Component calling `ownersListQueryKey()` would hit Next's client/server
 * boundary ("Attempted to call … from the server but … is on the client")
 * and crash the page render. Keeping the key shape here is the single source
 * of truth so server and client keys can NEVER drift (the
 * `SESSION_ME_QUERY_KEY` discipline; perf-research/01-rsc-waterfall.md §2.2).
 */

export const OWNERS_KEY = ['owners'] as const;

/**
 * Shape is `['owners', 'list', query, locale]` — `query` is the LITERAL
 * object passed to the hook (`{ limit, cursor, archived }`) and `locale` is
 * the narrowed `'he' | 'en'` from `useDisplayLocale()` (client) /
 * `getLocale()`-narrowed (server). A byte-for-byte match is load-bearing: a
 * mismatch = a silent cache miss = the prefetch is wasted and the waterfall
 * silently returns. TanStack `hashKey` JSON-serializes the query object and
 * drops `undefined` values, so `{ limit: 25, archived: false }` (server) and
 * `{ limit: 25, cursor: undefined, archived: false }` (client first render)
 * hash identically.
 */
export function ownersListQueryKey(
  query: { limit?: number; cursor?: string; archived?: boolean },
  locale: 'he' | 'en',
) {
  return [...OWNERS_KEY, 'list', query, locale] as const;
}
