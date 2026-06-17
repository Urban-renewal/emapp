import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { documentsListQueryKey } from '@/hooks/use-documents.keys';
import { serverListDocuments } from '@/lib/api/documents.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { DocumentsListClient } from './documents-list.client';

/**
 * Documents list — RSC server-prefetch (perf-research/01-rsc-waterfall.md
 * §5.2, fan-out batch 1). Async Server Component (NO `'use client'`): runs the
 * initial `GET /api/v1/documents?limit=25` ON THE SERVER during the HTML
 * stream, dehydrates it, and feeds it through `<HydrationBoundary>` so the
 * client `useDocumentList` hook resolves SYNCHRONOUSLY from the seeded cache
 * on first render — killing the fetch-after-hydration waterfall.
 *
 * Query-key parity is load-bearing: server uses `documentsListQueryKey` (the
 * SAME builder the hook uses) with `{ limit: 25, archived: false }` + route
 * locale. The page mounts in the ACTIVE view, so the client first render
 * passes `{ limit: 25, cursor: undefined, archived: false }`; `hashKey`
 * JSON-drops `undefined`, so the two hash identically — a guaranteed hit.
 * (The hook KEYS on the raw `query` it was passed; its queryFn separately
 * defaults `limit ?? 25`, which doesn't affect the key, so the server keys on
 * the same `{ limit, archived }` literal.)
 *
 * Failure posture: a failed `serverListDocuments` is swallowed by
 * `prefetchToDehydratedState` → empty cache → the client hook refetches via
 * its existing `<ListSkeleton>` / error UI. The page NEVER throws.
 */
export default async function DocumentsPage() {
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  // The page mounts in the ACTIVE view (archived: false) — match the client.
  const query = { limit: 25, archived: false };

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: documentsListQueryKey(query, locale),
        queryFn: () => serverListDocuments(query),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <DocumentsListClient />
    </HydrationBoundary>
  );
}
