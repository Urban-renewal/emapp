/**
 * Documents query-key builders — a PLAIN module (NO `'use client'`) so BOTH
 * the client hook (`use-documents.ts`) and the server RSC prefetch
 * (`documents/page.tsx`) can import AND call it. The client hook file is
 * `'use client'`, so a Server Component calling the builder from there would
 * hit Next's client/server boundary and crash the render. This plain module
 * is the single source of truth so server and client keys can NEVER drift (the
 * `SESSION_ME_QUERY_KEY` discipline; perf-research/01-rsc-waterfall.md §2.2).
 */

export const DOCUMENTS_KEY = ['documents'] as const;

/**
 * Shape is `['documents', 'list', query, locale]` — `query` is the LITERAL
 * object passed to the hook (`{ limit, cursor, projectId, apartmentId,
 * archived }`) and `locale` is the narrowed `'he' | 'en'`. A byte-for-byte
 * match is load-bearing (a mismatch = a silent cache miss). `hashKey`
 * JSON-drops `undefined`, so `{ limit: 25, archived: false }` (server) and
 * `{ limit: 25, cursor: undefined, archived: false }` (client first render)
 * hash identically.
 *
 * NOTE: the client hook KEYS on the raw `query` it was passed (the page
 * passes `{ limit: 25, cursor, archived }`) while its queryFn passes
 * `{ limit: query.limit ?? 25, ...query }` — the key is what we must match,
 * so the server keys on the SAME `{ limit, archived }` literal.
 */
export function documentsListQueryKey(
  query: {
    limit?: number;
    cursor?: string;
    projectId?: string;
    apartmentId?: string;
    archived?: boolean;
  },
  locale: 'he' | 'en',
) {
  return [...DOCUMENTS_KEY, 'list', query, locale] as const;
}

/**
 * Board-summary / board-completeness key (Phase 1). NO locale segment — the
 * response is counts + doc-type KEYS only (labels resolved at the component), so
 * it is identical across locales. A SINGLE-source builder (was an inline literal
 * in the hook) so the upload mutation can invalidate it by the exact same key.
 * Shape: `['documents', 'board-completeness']`.
 */
export function documentsBoardCompletenessQueryKey() {
  return [...DOCUMENTS_KEY, 'board-completeness'] as const;
}

/**
 * Server-side search key (Phase 1) — `['documents', 'search', args, locale]`.
 * `args` is the LITERAL search params object (`{ q, limit?, cursor?, type?,
 * party?, scope?, archived? }`); `locale` keys the adapter's localized labels in
 * `select` (the VM resolves typeLabel/parent labels per locale). Distinct queries
 * (different q/party/type) cache independently. `hashKey` JSON-drops `undefined`,
 * so unset filters never split the cache.
 */
export function documentsSearchQueryKey(
  args: {
    q: string;
    limit?: number;
    cursor?: string;
    type?: string;
    party?: string;
    scope?: 'project' | 'apartment' | 'org';
    archived?: boolean;
  },
  locale: 'he' | 'en',
) {
  return [...DOCUMENTS_KEY, 'search', args, locale] as const;
}
