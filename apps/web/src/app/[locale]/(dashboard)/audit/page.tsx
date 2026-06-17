import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { auditListQueryKey } from '@/hooks/use-audit.keys';
import { serverListAuditEntries } from '@/lib/api/audit.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { AuditListClient } from './audit-list.client';

/**
 * Audit log — RSC server-prefetch (perf-research/01-rsc-waterfall.md §5.2,
 * fan-out batch 2). This is an async Server Component (NO `'use client'`): it
 * runs the initial `GET /api/v1/audit?limit=25` ON THE SERVER during the HTML
 * stream, dehydrates the result, and feeds it through `<HydrationBoundary>` so
 * the client `useAuditList` hook resolves SYNCHRONOUSLY from the seeded cache
 * on first render. This kills the `'use client'` fetch-after-hydration
 * waterfall (~500ms cold dead-time before the list GET even started) — the
 * same technique PR 401 proved on `/me` and PR 406 piloted on projects.
 *
 * Query-key parity is load-bearing: the server uses `auditListQueryKey` (the
 * SAME exported builder the hook uses) with the `{ limit: 25 }` literal + the
 * route locale. The client's first render passes `{ limit: 25, cursor:
 * undefined }`; TanStack's `hashKey` JSON-serializes plain objects and drops
 * `undefined`, so the two hash identically — a guaranteed cache hit.
 *
 * Failure posture: `serverListAuditEntries` throws on any failure (including
 * the 403 that the Manager-only guard returns to non-Managers, surfaced as a
 * non-2xx → null from `serverApiGet` → invalid_response throw);
 * `prefetchToDehydratedState` swallows it → empty dehydrated state → the
 * client hook transparently runs its own fetch and renders the existing
 * access-denied / loading / error UI. The page NEVER throws.
 */
export default async function AuditPage() {
  // Narrow next-intl's `string` locale to the hook's `'he' | 'en'` so the
  // key's locale segment matches the client `useDisplayLocale()` exactly.
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const query = { limit: 25 };

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: auditListQueryKey(query, locale),
        queryFn: () => serverListAuditEntries(query),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <AuditListClient />
    </HydrationBoundary>
  );
}
