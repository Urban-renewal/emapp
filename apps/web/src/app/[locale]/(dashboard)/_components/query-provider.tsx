'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * Per docs/03 Phase 8 perf: TanStack Query with `staleTime: 30_000`
 * the default — individual hooks override when they need fresher data
 * (e.g. SSE-driven import status).
 *
 * `useState(() => new QueryClient(...))` per the official docs — keeps
 * one client per provider mount (so the client survives StrictMode's
 * double-render in dev, and a per-request fresh client in SSR).
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
