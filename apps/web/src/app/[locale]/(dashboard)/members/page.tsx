import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { membersListQueryKey } from '@/hooks/use-members.keys';
import { serverListMembers } from '@/lib/api/members.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { MembersListClient } from './members-list.client';

/**
 * Members list — RSC server-prefetch (perf-research/01-rsc-waterfall.md §5.2,
 * fan-out batch 1). Async Server Component (NO `'use client'`): runs the
 * initial `GET /api/v1/members?limit=25` ON THE SERVER during the HTML stream,
 * dehydrates it, and feeds it through `<HydrationBoundary>` so the client
 * `useMemberList` hook resolves SYNCHRONOUSLY from the seeded cache on first
 * render — killing the fetch-after-hydration waterfall.
 *
 * Query-key parity is load-bearing: server uses `membersListQueryKey` (the
 * SAME builder the hook uses) with the `{ limit: 25 }` literal + route locale.
 * The client first render passes `{ limit: 25, cursor: undefined }`; `hashKey`
 * JSON-drops `undefined`, so the two hash identically — a guaranteed hit.
 *
 * Failure posture: members is Manager-only (D.17). A non-Manager session's
 * forwarded cookie yields a 403 → `serverListMembers` throws → swallowed by
 * `prefetchToDehydratedState` → empty cache → the client surfaces the SAME
 * `loadFailed` UI as today. The page NEVER throws.
 */
export default async function MembersPage() {
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const query = { limit: 25 };

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: membersListQueryKey(query, locale),
        queryFn: () => serverListMembers(query),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <MembersListClient />
    </HydrationBoundary>
  );
}
