import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { projectQueryKey } from '@/hooks/use-projects.keys';
import { serverGetProject } from '@/lib/api/projects.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { ProjectDetailClient } from './project-detail.client';

/**
 * Project detail — RSC server-prefetch (perf-research/01-rsc-waterfall.md §2.4
 * detail variant). Async Server Component (NO `'use client'`): it runs the
 * page's single mount query — `GET /api/v1/projects/:id` — ON THE SERVER during
 * the HTML stream, dehydrates it, and feeds it through `<HydrationBoundary>` so
 * the client `useProject(id)` hook resolves SYNCHRONOUSLY from the seeded cache
 * on first render. This kills the `'use client'` fetch-after-hydration
 * waterfall — same technique PR 401 proved on `/me` and PR 406 piloted on the
 * projects list.
 *
 * Mount queries on this page: ONLY `useProject(id)`. The signature-progress
 * hooks (`useSignatureProgress` / `useSignatureProgressApartments`) live INSIDE
 * the `SignatureProgressBoard` / `SignatureProgressApartments` child components,
 * which render only on the `dashboard` tab (and the apartments drill-down is
 * lazily enabled on first open) — so they are NOT first-mount queries and are
 * intentionally left to their existing client fetch path.
 *
 * Query-key parity is load-bearing: the server uses `projectQueryKey(id, locale)`
 * (the SAME exported builder `useProject` uses) so the two hash identically — a
 * guaranteed cache hit, not an accidental one.
 *
 * Failure posture: `serverGetProject` throws on any failure;
 * `prefetchToDehydratedState` swallows it → empty dehydrated state → the client
 * hook transparently runs its own fetch + existing loading/error/not-found UI.
 * The page NEVER throws. Next 15: `params` is a Promise — await it.
 */
export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Narrow next-intl's `string` locale to the hook's `'he' | 'en'` so the key's
  // locale segment matches the client `useDisplayLocale()` exactly.
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: projectQueryKey(id, locale),
        queryFn: () => serverGetProject(id),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <ProjectDetailClient />
    </HydrationBoundary>
  );
}
