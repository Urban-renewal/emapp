import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { notesListQueryKey } from '@/hooks/use-notes.keys';
import { serverListNotes } from '@/lib/api/notes.server';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { NotesListClient } from './notes-list.client';

/**
 * Notes list — RSC server-prefetch (perf-research/01-rsc-waterfall.md §5.2,
 * fan-out batch 2). This is an async Server Component (NO `'use client'`): it
 * runs the initial `GET /api/v1/notes?limit=25` ON THE SERVER during the HTML
 * stream, dehydrates the result, and feeds it through `<HydrationBoundary>` so
 * the client `useNoteList` hook resolves SYNCHRONOUSLY from the seeded cache
 * on first render. This kills the `'use client'` fetch-after-hydration
 * waterfall (~500ms cold dead-time before the list GET even started) — the
 * same technique PR 401 proved on `/me` and PR 406 piloted on projects.
 *
 * Query-key parity is load-bearing: the server uses `notesListQueryKey` (the
 * SAME exported builder the hook uses) with the `{ limit: 25 }` literal + the
 * route locale. The client's first render passes `{ limit: 25, cursor:
 * undefined }`; TanStack's `hashKey` JSON-serializes plain objects and drops
 * `undefined`, so the two hash identically — a guaranteed cache hit.
 *
 * Failure posture: `serverListNotes` throws on any failure;
 * `prefetchToDehydratedState` swallows it → empty dehydrated state → the
 * client hook transparently runs its own fetch + existing loading/error UI.
 * The page NEVER throws. (The `/members` side-load stays client-only — it is
 * a Manager-only enrichment with its own retry: false cache slot.)
 */
export default async function NotesPage() {
  // Narrow next-intl's `string` locale to the hook's `'he' | 'en'` so the
  // key's locale segment matches the client `useDisplayLocale()` exactly.
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const query = { limit: 25 };

  const dehydratedState = await prefetchToDehydratedState([
    (qc) =>
      qc.prefetchQuery({
        queryKey: notesListQueryKey(query, locale),
        queryFn: () => serverListNotes(query),
      }),
  ]);

  return (
    <HydrationBoundary state={dehydratedState}>
      <NotesListClient />
    </HydrationBoundary>
  );
}
