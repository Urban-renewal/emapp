/**
 * Audit query-key builders — a PLAIN module (NO `'use client'`) so BOTH
 * the client hook (`use-audit.ts`) and the server RSC prefetch
 * (`audit/page.tsx`) can import AND call it. The builder previously lived
 * inline in `use-audit.ts`, but that file is `'use client'`, so a Server
 * Component calling `auditListQueryKey()` would hit Next's client/server
 * boundary ("Attempted to call … from the server but … is on the client")
 * and crash the page render. Keeping the key shape here is the single source
 * of truth so server and client keys can NEVER drift (the
 * `SESSION_ME_QUERY_KEY` discipline; perf-research/01-rsc-waterfall.md §2.2).
 */

export const AUDIT_KEY = ['audit'] as const;

/**
 * Shape is `['audit', 'list', query, locale]` — `query` is the LITERAL
 * object passed to the hook (`{ limit, cursor }`) and `locale` is the narrowed
 * `'he' | 'en'` from `useDisplayLocale()` (client) / `getLocale()`-narrowed
 * (server). A byte-for-byte match is load-bearing: a mismatch = a silent cache
 * miss = the prefetch is wasted and the waterfall silently returns. TanStack
 * `hashKey` JSON-serializes the query object and drops `undefined` values, so
 * `{ limit: 25 }` (server) and `{ limit: 25, cursor: undefined }` (client
 * first render) hash identically.
 */
export function auditListQueryKey(query: { limit?: number; cursor?: string }, locale: 'he' | 'en') {
  return [...AUDIT_KEY, 'list', query, locale] as const;
}
