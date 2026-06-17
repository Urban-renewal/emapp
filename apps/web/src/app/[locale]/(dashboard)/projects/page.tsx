import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { projectsListQueryKey } from '@/hooks/use-projects.keys';
import { serverListProjects } from '@/lib/api/projects.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { ProjectsListClient } from './projects-list.client';

/**
 * Projects list — RSC server-prefetch PILOT
 * (perf-research/01-rsc-waterfall.md §5.2 step 3). This is now an async
 * Server Component (NO `'use client'`): it runs the initial
 * `GET /api/v1/projects?limit=25` ON THE SERVER during the HTML stream,
 * dehydrates the result, and feeds it through `<HydrationBoundary>` so the
 * client `useProjectList` hook resolves SYNCHRONOUSLY from the seeded cache
 * on first render. This kills the `'use client'` fetch-after-hydration
 * waterfall (~500ms–1.4s of cold dead-time before the list GET even
 * started) — the same technique PR 401 proved on `/me`.
 *
 * Query-key parity is load-bearing: the server uses `projectsListQueryKey`
 * (the SAME exported builder the hook uses) with the IDENTICAL `{ limit: 25 }`
 * literal + the route locale. The client's first render passes
 * `{ limit: 25, cursor: undefined }`; TanStack's `hashKey` JSON-serializes
 * plain objects with sorted keys and JSON.stringify drops `undefined`, so
 * `{ limit: 25 }` and `{ limit: 25, cursor: undefined }` hash identically —
 * a guaranteed cache hit, not an accidental one.
 *
 * Failure posture: `serverListProjects` returns/throws on any failure
 * (refused Host, missing/expired cookie, non-2xx, timeout, bad wire shape);
 * `prefetchToDehydratedState` swallows it → empty dehydrated state → the
 * client hook transparently runs its own fetch + existing loading/error UI.
 * The page NEVER throws.
 */
export default async function ProjectsPage() {
  // Narrow next-intl's `string` locale to the hook's `'he' | 'en'` so the
  // key's locale segment matches the client `useDisplayLocale()` exactly.
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: projectsListQueryKey({ limit: 25 }, locale),
        queryFn: () => serverListProjects({ limit: 25 }),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <ProjectsListClient />
    </HydrationBoundary>
  );
}
