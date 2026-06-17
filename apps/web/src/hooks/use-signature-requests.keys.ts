/**
 * Signature-requests query-key builders — a PLAIN module (NO `'use client'`)
 * so BOTH the client hook (`use-signature-requests.ts`) and the server RSC
 * prefetch (`signature-requests/page.tsx`) can import AND call it. The client
 * hook file is `'use client'`, so a Server Component calling the builder from
 * there would hit Next's client/server boundary and crash the render. This
 * plain module is the single source of truth so server and client keys can
 * NEVER drift (the `SESSION_ME_QUERY_KEY` discipline;
 * perf-research/01-rsc-waterfall.md §2.2).
 */
import type { ListSignatureRequestsQueryDto } from '@emapp/shared-types';

export const SIGREQ_KEY = ['signature-requests'] as const;

/**
 * Shape is `['signature-requests', 'list', query, locale]` — `query` is the
 * LITERAL object passed to the hook (`Partial<ListSignatureRequestsQueryDto>`,
 * e.g. `{ limit, cursor, status }`) and `locale` is the narrowed `'he' | 'en'`.
 * A byte-for-byte match is load-bearing (a mismatch = a silent cache miss).
 * `hashKey` JSON-drops `undefined`, so `{ limit: 25 }` (server initial) and
 * `{ limit: 25, cursor: undefined }` (client first render, status='all' so no
 * status key) hash identically.
 */
export function signatureRequestsListQueryKey(
  query: Partial<ListSignatureRequestsQueryDto>,
  locale: 'he' | 'en',
) {
  return [...SIGREQ_KEY, 'list', query, locale] as const;
}
