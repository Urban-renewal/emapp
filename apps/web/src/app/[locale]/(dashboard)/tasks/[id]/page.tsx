import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { taskQueryKey } from '@/hooks/use-tasks.keys';
import { serverGetTask } from '@/lib/api/tasks.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { TaskDetailClient } from './task-detail.client';

/**
 * Task detail — RSC server-prefetch (perf-research/01-rsc-waterfall.md §2.4
 * detail variant). Async Server Component (NO `'use client'`): it runs the
 * page's primary mount query — `GET /api/v1/tasks/:id` — ON THE SERVER during
 * the HTML stream, dehydrates it, and feeds it through `<HydrationBoundary>` so
 * the client `useTask(id)` hook resolves SYNCHRONOUSLY from the seeded cache on
 * first render, killing the fetch-after-hydration waterfall.
 *
 * Mount queries on this page: the primary is `useTask(id)` (prefetched here).
 * NOT prefetched (by design):
 *  - the `/members` side-load (`['members','list',…,'task-detail-side-load']`)
 *    is a Manager-only PERMISSION PROBE with `retry: false` — for an Agent/Viewer
 *    it 403s, and its success/failure IS the `isManager` UI signal. Prefetching
 *    it server-side would risk poisoning that probe (and it isn't the page's
 *    data, it's an authz gate), so it is intentionally left to the client.
 *  - `useTaskAssignees(id, lookup)` depends on the `lookup` Map derived from the
 *    members side-load, so it can't be keyed/prefetched ahead of that probe.
 * Both keep their existing client fetch path; only the load-bearing `useTask`
 * query is moved to the server.
 *
 * Query-key parity is load-bearing: `taskQueryKey(id, locale)` is the SAME
 * exported builder `useTask` uses, so server and client keys hash identically.
 *
 * Failure posture: `serverGetTask` throws on any failure (incl. a BE
 * service-layer 404 for a task an Agent isn't assigned to);
 * `prefetchToDehydratedState` swallows it → empty dehydrated state → the client
 * hook transparently runs its own fetch + existing loading/error/not-found UI.
 * The page NEVER throws. Next 15: `params` is a Promise — await it.
 */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Narrow next-intl's `string` locale to the hook's `'he' | 'en'` so the key's
  // locale segment matches the client `useDisplayLocale()` exactly.
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: taskQueryKey(id, locale),
        queryFn: () => serverGetTask(id),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <TaskDetailClient />
    </HydrationBoundary>
  );
}
