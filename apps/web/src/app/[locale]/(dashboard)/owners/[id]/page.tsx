import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { ownerProjectsQueryKey, ownerQueryKey } from '@/hooks/use-owners.keys';
import { serverGetOwner, serverGetOwnerProjects } from '@/lib/api/owners.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { OwnerDetailClient } from './owner-detail.client';

/**
 * Owner detail (dossier) — RSC server-prefetch, DETAIL fan-out variant
 * (perf-research/01-rsc-waterfall.md §2.4). Async Server Component (NO
 * `'use client'`): it runs BOTH of the page's first-mount queries —
 * `GET /api/v1/owners/:id` (the masked dossier) and `GET /api/v1/owners/:id/projects`
 * (the projects this owner is tied to) — ON THE SERVER, IN PARALLEL
 * (`prefetchToDehydratedState` does `Promise.all`), so the server pays ONE RTT
 * of wall-clock for both instead of the client firing them sequentially after
 * hydration. The dehydrated state seeds `<HydrationBoundary>` so `useOwner(id)`
 * and `useOwnerProjects(id)` both resolve SYNCHRONOUSLY on first render.
 *
 * Mount queries on this page: `useOwner(id)` + `useOwnerProjects(id)`. NOT
 * prefetched (by design): `useSessionProfile` (already seeded by the dashboard
 * layout, PR 401) and the D.54 cleartext PII reveal (`useRevealOwnerPii`) — that
 * is a SEPARATE step-up POST endpoint whose cleartext must NEVER enter the
 * (inspectable) TanStack cache, so it is deliberately untouched here.
 *
 * PII: the owner DETAIL endpoint returns the SAME MASKED projection as the list
 * (`nationalIdMasked` / `phoneMasked`); only masked PII is ever dehydrated.
 *
 * Query-key parity is load-bearing: `ownerQueryKey(id, locale)` (locale-keyed)
 * and `ownerProjectsQueryKey(id)` (NO locale — the projects adapter is
 * locale-independent, matching the hook) are the SAME exported builders the
 * hooks use, so server and client keys hash identically.
 *
 * Failure posture: each server fetch throws on failure; both are isolated and
 * swallowed inside `prefetchToDehydratedState` → an empty/partial dehydrated
 * cache → the affected client hook transparently refetches with its existing
 * loading/error/not-found UI. The page NEVER throws. Next 15: `params` is a
 * Promise — await it.
 */
export default async function OwnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Narrow next-intl's `string` locale to the hook's `'he' | 'en'` so the
  // owner key's locale segment matches the client `useDisplayLocale()` exactly.
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: ownerQueryKey(id, locale),
        queryFn: () => serverGetOwner(id),
      }),
    (qc) =>
      qc.prefetchQuery({
        queryKey: ownerProjectsQueryKey(id),
        queryFn: () => serverGetOwnerProjects(id),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <OwnerDetailClient />
    </HydrationBoundary>
  );
}
