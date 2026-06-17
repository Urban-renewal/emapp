/**
 * Members query-key builders — a PLAIN module (NO `'use client'`) so BOTH the
 * client hook (`use-members.ts`) and the server RSC prefetch
 * (`members/page.tsx`) can import AND call it. `use-members.ts` is
 * `'use client'`, so a Server Component calling the builder from there would
 * hit Next's client/server boundary and crash the render. This plain module
 * is the single source of truth so server and client keys can NEVER drift (the
 * `SESSION_ME_QUERY_KEY` discipline; perf-research/01-rsc-waterfall.md §2.2).
 */

export const MEMBERS_KEY = ['members'] as const;

/**
 * Shape is `['members', 'list', query, locale]` — `query` is the LITERAL
 * object passed to the hook (`{ limit, cursor }`) and `locale` is the narrowed
 * `'he' | 'en'`. A byte-for-byte match is load-bearing (a mismatch = a silent
 * cache miss). `hashKey` JSON-drops `undefined`, so `{ limit: 25 }` (server)
 * and `{ limit: 25, cursor: undefined }` (client) hash identically.
 */
export function membersListQueryKey(
  query: { limit?: number; cursor?: string },
  locale: 'he' | 'en',
) {
  return [...MEMBERS_KEY, 'list', query, locale] as const;
}
