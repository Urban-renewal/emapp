import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { signatureRequestsListQueryKey } from '@/hooks/use-signature-requests.keys';
import { serverListSignatureRequests } from '@/lib/api/signature-requests.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { SignatureRequestsListClient } from './signature-requests-list.client';

/**
 * Signature-requests list — RSC server-prefetch
 * (perf-research/01-rsc-waterfall.md §5.2, fan-out batch 1). Async Server
 * Component (NO `'use client'`): runs the initial
 * `GET /api/v1/signature-requests?limit=25` ON THE SERVER during the HTML
 * stream, dehydrates it, and feeds it through `<HydrationBoundary>` so the
 * client `useSignatureRequestList` hook resolves SYNCHRONOUSLY from the seeded
 * cache on first render — killing the fetch-after-hydration waterfall.
 *
 * Query-key parity is load-bearing: server uses
 * `signatureRequestsListQueryKey` (the SAME builder the hook uses) with the
 * `{ limit: 25 }` literal + route locale. The page mounts with statusFilter
 * 'all', so the client first render passes `{ limit: 25, cursor: undefined }`
 * (no `status` key); `hashKey` JSON-drops `undefined`, so the two hash
 * identically — a guaranteed hit.
 *
 * Failure posture: a failed `serverListSignatureRequests` is swallowed by
 * `prefetchToDehydratedState` → empty cache → the client hook refetches via
 * its existing `<ListSkeleton>` / error UI. The page NEVER throws.
 */
export default async function SignatureRequestsPage() {
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const query = { limit: 25 };

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: signatureRequestsListQueryKey(query, locale),
        queryFn: () => serverListSignatureRequests(query),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <SignatureRequestsListClient />
    </HydrationBoundary>
  );
}
