/**
 * Projects query-key builders — a PLAIN module (NO `'use client'`) so BOTH
 * the client hook (`use-projects.ts`) and the server RSC prefetch
 * (`projects/page.tsx`) can import AND call it. The builder previously lived
 * in `use-projects.ts`, but that file is `'use client'`, so a Server Component
 * calling `projectsListQueryKey()` hit Next's client/server boundary
 * ("Attempted to call … from the server but … is on the client") and crashed
 * the page render. Keeping the key shape here is the single source of truth so
 * server and client keys can NEVER drift (the `SESSION_ME_QUERY_KEY`
 * discipline; perf-research/01-rsc-waterfall.md §2.2).
 */

export const PROJECTS_KEY = ['projects'] as const;

/**
 * Shape is `['projects', 'list', query, locale]` — `query` is the LITERAL
 * object passed to the hook (`{ limit, cursor }`) and `locale` is the narrowed
 * `'he' | 'en'` from `useDisplayLocale()` (client) / `getLocale()`-narrowed
 * (server). A byte-for-byte match is load-bearing: a mismatch = a silent cache
 * miss = the prefetch is wasted and the waterfall silently returns.
 */
export function projectsListQueryKey(
  query: { limit?: number; cursor?: string },
  locale: 'he' | 'en',
) {
  return [...PROJECTS_KEY, 'list', query, locale] as const;
}

/**
 * Shape is `['projects', 'one', id, locale]` — the SINGLE-record detail key
 * `useProject(id)` reads. Same byte-for-byte parity discipline as the list
 * builder: the server RSC prefetch (`projects/[id]/page.tsx`) and the client
 * hook MUST hash identically or the prefetch is a silent cache miss and the
 * fetch-after-hydration waterfall returns.
 */
export function projectQueryKey(id: string, locale: 'he' | 'en') {
  return [...PROJECTS_KEY, 'one', id, locale] as const;
}
