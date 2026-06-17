/**
 * Server-only TanStack prefetch helper — the reusable core of the RSC
 * server-prefetch pattern (perf-research/01-rsc-waterfall.md §2.4).
 *
 * A `(dashboard)/<entity>/page.tsx` Server Component runs its initial
 * query (or queries, in parallel for detail pages that fan out) into a
 * THROWAWAY request-scoped `QueryClient`, dehydrates it, and feeds the
 * result through a `<HydrationBoundary>` so the existing client hook
 * resolves from the dehydrated cache on first render — zero client
 * round-trip, killing the post-hydration fetch waterfall.
 *
 * This is a PLAIN server module: it has NO `'use server'` directive on
 * purpose. Turbopack's Server-Actions transform registers every export
 * of a `'use server'` module as a runtime action and 500s on non-async
 * / non-function exports (perf-research §4.7). These helpers are called
 * from Server Components (not as form actions), so they must stay out of
 * the `'use server'` graph.
 *
 * Failure posture: `prefetchQuery` does NOT throw by default — a failed
 * prefetch (API 5xx / timeout / cookie-not-forwarded → 401) leaves an
 * empty cache entry and the client hook transparently falls back to its
 * own loading/error path. So a single prefetch failure never throws out
 * of the page. We harden that contract here by swallowing any prefetch
 * rejection (see `prefetchToDehydratedState`) so a thrown queryFn can't
 * crash the Server Component render either.
 */
import { dehydrate, QueryClient, type DehydratedState } from '@tanstack/react-query';

/**
 * Run N prefetches into a throwaway `QueryClient` (in parallel — detail
 * pages fan out, so the server pays ONE RTT of wall-clock for all of
 * them) and return the dehydrated state.
 *
 * Each prefetch is isolated: one rejecting prefetch never aborts the
 * others and never throws out of this helper. The worst case is a
 * partially-populated (or empty) dehydrated cache, which degrades
 * gracefully to the client's existing fetch path.
 */
export async function prefetchToDehydratedState(
  prefetches: Array<(qc: QueryClient) => Promise<unknown>>,
): Promise<DehydratedState> {
  const qc = new QueryClient();
  await Promise.all(
    // `prefetchQuery` itself never rejects, but a queryFn that throws
    // synchronously (or a future caller using `fetchQuery`) could — guard
    // so the Server Component render is never crashed by a data error.
    prefetches.map((p) =>
      p(qc).catch(() => {
        // Swallowed by design — empty/partial cache → client refetch path.
      }),
    ),
  );
  return dehydrate(qc);
}
