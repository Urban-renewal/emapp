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
  query: { limit?: number; cursor?: string; archived?: boolean; needsAttention?: boolean },
  locale: 'he' | 'en',
) {
  return [...OWNERS_KEY, 'list', query, locale] as const;
}

/**
 * B1 — the search key the name-search query reads. Shape is
 * `['owners', 'search', query, locale]` — a SEPARATE namespace from 'list' so a
 * search page caches independently of the unfiltered list (and is invalidated
 * by the same `OWNERS_KEY` prefix on a create/archive). `query` is the literal
 * object (`{ q, limit, cursor, needsAttention }`); TanStack `hashKey` drops
 * `undefined`, so distinct searches cache distinctly.
 */
export function ownersSearchQueryKey(
  query: { q: string; limit?: number; cursor?: string; needsAttention?: boolean },
  locale: 'he' | 'en',
) {
  return [...OWNERS_KEY, 'search', query, locale] as const;
}

/**
 * Shape is `['owners', 'one', id, locale]` — the SINGLE-record detail key
 * `useOwner(id)` reads. The detail endpoint returns the SAME masked PII
 * projection as the list (`nationalIdMasked` / `phoneMasked`); the cleartext
 * reveal is a SEPARATE step-up endpoint and is NEVER prefetched. Byte-for-byte
 * key parity with the client hook is load-bearing (a mismatch = silent cache
 * miss = waterfall returns).
 */
export function ownerQueryKey(id: string, locale: 'he' | 'en') {
  return [...OWNERS_KEY, 'one', id, locale] as const;
}

/**
 * Shape is `['owners', 'projects', id]` — the key `useOwnerProjects(id)` reads
 * (the DISTINCT projects an owner is tied to via active ownerships). NOTE: this
 * key has NO `locale` segment — the hook's adapter is locale-independent, so
 * the hook omits it. The server prefetch MUST match that exactly (no locale).
 */
export function ownerProjectsQueryKey(id: string) {
  return [...OWNERS_KEY, 'projects', id] as const;
}
