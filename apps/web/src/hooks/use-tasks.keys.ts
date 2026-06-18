/**
 * Tasks query-key builders — a PLAIN module (NO `'use client'`) so BOTH the
 * client hook (`use-tasks.ts`) and the server RSC prefetch (`tasks/page.tsx`)
 * can import AND call it. `use-tasks.ts` is `'use client'`, so a Server
 * Component calling the builder from there would hit Next's client/server
 * boundary and crash the render. This plain module is the single source of
 * truth so server and client keys can NEVER drift (the `SESSION_ME_QUERY_KEY`
 * discipline; perf-research/01-rsc-waterfall.md §2.2).
 */

export const TASKS_KEY = ['tasks'] as const;

/**
 * Shape is `['tasks', 'list', query, locale]` — `query` is the LITERAL object
 * passed to the hook (`{ limit, cursor }`) and `locale` is the narrowed
 * `'he' | 'en'`. A byte-for-byte match is load-bearing (a mismatch = a silent
 * cache miss). `hashKey` JSON-drops `undefined`, so `{ limit: 25 }` (server)
 * and `{ limit: 25, cursor: undefined }` (client) hash identically.
 */
export function tasksListQueryKey(query: { limit?: number; cursor?: string }, locale: 'he' | 'en') {
  return [...TASKS_KEY, 'list', query, locale] as const;
}

/**
 * Shape is `['tasks', 'one', id, locale]` — the SINGLE-record detail key
 * `useTask(id)` reads. Same byte-for-byte parity discipline as the list
 * builder: the server RSC prefetch (`tasks/[id]/page.tsx`) and the client hook
 * MUST hash identically or the prefetch is a silent cache miss and the
 * fetch-after-hydration waterfall returns.
 */
export function taskQueryKey(id: string, locale: 'he' | 'en') {
  return [...TASKS_KEY, 'one', id, locale] as const;
}
