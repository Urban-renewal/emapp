import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { signatureRequestsListQueryKey } from '@/hooks/use-signature-requests.keys';
import { serverGetSignaturePulse } from '@/lib/api/signature-pulse.server';
import { serverListSignatureRequests } from '@/lib/api/signature-requests.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { SignatureRequestsListClient } from './signature-requests-list.client';

/**
 * Signature-requests situation-picture — RSC server-prefetch
 * (perf-research/01-rsc-waterfall.md §5.2, fan-out batch 1). Async Server
 * Component (NO `'use client'`): runs BOTH initial fetches ON THE SERVER during
 * the HTML stream, in PARALLEL (one RTT of wall-clock), dehydrates them, and
 * feeds them through `<HydrationBoundary>` so the client hooks resolve
 * SYNCHRONOUSLY from the seeded cache on first render — killing the
 * fetch-after-hydration waterfall:
 *
 *   1. `GET /api/v1/signature-requests?limit=25` — the flat "כל הבקשות" list.
 *   2. `GET /api/v1/org/signature-pulse` — the Tier 0-2 situation-picture
 *      (pulse sentence / ranked attention / fleet). Slice-1 redesign: the
 *      signatures surface is now the same board-first pattern as the home, so
 *      its pulse must hydrate synchronously too.
 *
 * Query-key parity is load-bearing:
 *   - the list uses `signatureRequestsListQueryKey({ limit: 25 }, locale)` (the
 *     SAME builder the hook uses); the page mounts statusFilter 'all' so the
 *     client first render passes `{ limit: 25, cursor: undefined }` (no `status`
 *     key) and `hashKey` JSON-drops `undefined` → a guaranteed hit.
 *   - the pulse uses the literal `['signature-pulse']` key (the SAME key
 *     `useSignaturePulse` reads); the hook's `select` adapter runs client-side,
 *     so the dehydrated entry holds the RAW `SignaturePulse` wire shape.
 *
 * Failure posture: each failed prefetch is swallowed by
 * `prefetchToDehydratedState` → that one cache entry stays empty → the client
 * hook refetches via its existing skeleton/error UI. The page NEVER throws, and
 * one prefetch failing never aborts the other.
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
    (qc) =>
      qc.prefetchQuery({
        // Parity with `useSignaturePulse` (queryKey ['signature-pulse']); the
        // hook's `select` adapts the raw wire client-side, so we seed the wire.
        queryKey: ['signature-pulse'],
        queryFn: () => serverGetSignaturePulse(),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <SignatureRequestsListClient />
    </HydrationBoundary>
  );
}
