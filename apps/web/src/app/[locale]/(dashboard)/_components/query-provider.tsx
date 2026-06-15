'use client';

import type { UserProfile } from '@emapp/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { SESSION_ME_QUERY_KEY } from '@/hooks/use-session';
import { ApiClientError } from '@/lib/api/errors';

/**
 * TanStack Query defaults per docs/03 Phase 8 perf + Doc 02 §11.5.
 *
 * Trade-offs (§v9-M-6 + §v9-M-8 closures):
 *   - `staleTime: 30_000` — cache freshness window. Individual hooks
 *     override when they need fresher data (SSE-driven import status).
 *   - `refetchOnWindowFocus: true` — Agent C default; users with two
 *     tabs see the other tab's writes on re-focus. Cost = an extra
 *     query per focus event; mitigated by `staleTime`.
 *   - `retry` (§PERF-4) — a structured `ApiClientError` is a definitive
 *     server RESPONSE: a 4xx the user must act on (404/403/422 — a retry
 *     changes nothing) or a 5xx/timeout the server already returned. The
 *     old blanket `retry: 3` retried these with 1s/2s/4s backoff, so a
 *     404 took ~7s to even surface. We now show such errors after the
 *     FIRST attempt and retry only genuine NETWORK failures (fetch
 *     rejected → a raw Error, not an ApiClientError), capped at 2 tries
 *     with a tight backoff (250ms/500ms, ≤2s). MUTATIONS stay at
 *     `retry: 0` because the api-client `postIdempotent` helper mints a
 *     NEW UUID per call (double-create on retry).
 *
 * `useState(() => new QueryClient(...))` per the official docs —
 * keeps one client per provider mount (so the client survives
 * StrictMode's double-render in dev, and a per-request fresh client
 * in SSR).
 */
export function QueryProvider({
  children,
  initialSession,
}: {
  children: ReactNode;
  /**
   * The org-tier profile already resolved by the dashboard layout
   * server-side. When present it SEEDS the `['session','me']` cache so
   * `useSessionProfile` reads it on first paint instead of firing a
   * redundant client-side `/me` (which is ~4 DB round-trips). Undefined
   * for the Provider tier (that console doesn't use this org hook).
   */
  initialSession?: UserProfile;
}) {
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          refetchOnWindowFocus: true,
          // §PERF-4 — never retry a definitive server response; retry
          // only transient network failures, and cap the backoff so
          // even those surface fast.
          retry: (failureCount, error) => {
            if (error instanceof ApiClientError) return false;
            return failureCount < 2;
          },
          retryDelay: (attempt) => Math.min(250 * 2 ** attempt, 2000),
        },
        mutations: {
          retry: 0,
        },
      },
    });
    // §PERF — hydrate the session cache from the server-resolved profile.
    // `useSessionProfile` (staleTime 5min) then returns this without a
    // network call until it goes stale. Same value the hook would parse,
    // so no hydration mismatch.
    if (initialSession) queryClient.setQueryData(SESSION_ME_QUERY_KEY, initialSession);
    return queryClient;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
