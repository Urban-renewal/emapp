import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { tasksListQueryKey } from '@/hooks/use-tasks.keys';
import { serverListTasks } from '@/lib/api/tasks.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { TasksListClient } from './tasks-list.client';

/**
 * Tasks list — RSC server-prefetch (perf-research/01-rsc-waterfall.md §5.2,
 * fan-out batch 1). Async Server Component (NO `'use client'`): runs the
 * initial `GET /api/v1/tasks?limit=25` ON THE SERVER during the HTML stream,
 * dehydrates it, and feeds it through `<HydrationBoundary>` so the client
 * `useTaskList` hook resolves SYNCHRONOUSLY from the seeded cache on first
 * render — killing the fetch-after-hydration waterfall (same technique as
 * PR 401 / PR 406).
 *
 * Query-key parity is load-bearing: server uses `tasksListQueryKey` (the SAME
 * builder the hook uses) with the `{ limit: 25 }` literal + route locale. The
 * client first render passes `{ limit: 25, cursor: undefined }`; `hashKey`
 * JSON-drops `undefined`, so the two hash identically — a guaranteed hit.
 *
 * Failure posture: a failed `serverListTasks` is swallowed by
 * `prefetchToDehydratedState` → empty cache → the client hook refetches via
 * its existing loading/error UI. The page NEVER throws.
 */
export default async function TasksPage() {
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const query = { limit: 25 };

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: tasksListQueryKey(query, locale),
        queryFn: () => serverListTasks(query),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <TasksListClient />
    </HydrationBoundary>
  );
}
