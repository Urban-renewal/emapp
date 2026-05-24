'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * TanStack Query defaults per docs/03 Phase 8 perf + Doc 02 §11.5.
 *
 * Trade-offs (§v9-M-6 + §v9-M-8 closures):
 *   - `staleTime: 30_000` — cache freshness window. Individual hooks
 *     override when they need fresher data (SSE-driven import status).
 *   - `refetchOnWindowFocus: true` — Agent C default; users with two
 *     tabs see the other tab's writes on re-focus. Cost = an extra
 *     query per focus event; mitigated by `staleTime`.
 *   - `retry: 3` with exponential backoff (1s, 2s, 4s capped at 30s)
 *     — covers transient 5xx + network blips. MUTATIONS stay at
 *     `retry: 0` because the api-client `postIdempotent` helper
 *     mints a NEW UUID per call (double-create on retry); the BE-side
 *     Idempotency-Key dedup would catch it but UI feedback is cleaner
 *     without auto-retry.
 *
 * `useState(() => new QueryClient(...))` per the official docs —
 * keeps one client per provider mount (so the client survives
 * StrictMode's double-render in dev, and a per-request fresh client
 * in SSR).
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: 3,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
