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

import type { ProjectSegment, ProjectStatus } from '@emapp/shared-types';

export const PROJECTS_KEY = ['projects'] as const;

/**
 * Shape is `['projects', 'list', query, locale]` — `query` is the LITERAL
 * object passed to the hook (`{ limit, cursor, q?, status?, segment? }`) and
 * `locale` is the narrowed `'he' | 'en'` from `useDisplayLocale()` (client) /
 * `getLocale()`-narrowed (server). A byte-for-byte match is load-bearing: a
 * mismatch = a silent cache miss = the prefetch is wasted and the waterfall
 * silently returns.
 *
 * NS6 (MASTER-PLAN-V13 Wave C) — the optional NS1 server-search params
 * (`q` / `status` / `segment`) join the key so each distinct query caches
 * independently. They are ABSENT (never present with an `undefined` value) on
 * the unfiltered first page, so the no-filter key `{ limit: 25 }` still hashes
 * IDENTICALLY to the server RSC prefetch key — TanStack's `hashKey`
 * JSON-serializes and `JSON.stringify` drops `undefined`, so an unset filter
 * never breaks the cache-hit the `page.tsx` prefetch depends on.
 */
export function projectsListQueryKey(
  query: {
    limit?: number;
    cursor?: string;
    q?: string;
    status?: ProjectStatus;
    segment?: ProjectSegment;
  },
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

/**
 * Shape is `['projects', 'document-checklist', id, locale]` — the advisory
 * per-project required-docs checklist (DH2/V13). Locale-keyed because the
 * adapter resolves missing doc-types to localized labels in `select`.
 */
export function projectDocumentChecklistQueryKey(id: string, locale: 'he' | 'en') {
  return [...PROJECTS_KEY, 'document-checklist', id, locale] as const;
}
