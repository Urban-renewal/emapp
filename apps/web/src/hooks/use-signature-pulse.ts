'use client';

import type { SignaturePulse } from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toSignaturePulseViewModel } from '@/adapters/signature-pulse';
import { getSignaturePulse } from '@/lib/api/signature-pulse';
import type { SignaturePulseViewModel } from '@/models/signature-pulse.vm';

/**
 * Signature-pulse hook — the board-first home's data source (E2 Wave-2 E2.1).
 *
 * Reads `GET /api/v1/org/signature-pulse` and adapts the wire to the
 * `SignaturePulseViewModel` inside TanStack's `select` (the adapter is pure, so
 * the home component only ever sees pre-derived cards + the all-clear flag).
 *
 * The endpoint is scope-aware on the BE (manager/viewer → whole org; agent →
 * assigned projects only), so the SAME hook backs both ManagerHome and
 * AgentHome — no extra widening, no role branch in the FE.
 *
 * §PERF-H3 — the `select` is memoised so TanStack's structuralSharing can dedupe
 * (an inline arrow allocates a new identity every render and defeats it).
 *
 * staleTime 30s + refetchOnWindowFocus (the QueryClient default) so a manager
 * returning to the tab sees a fresh pulse after the background chasers ran.
 */
export function useSignaturePulse() {
  const select = useCallback(
    (data: SignaturePulse): SignaturePulseViewModel => toSignaturePulseViewModel(data),
    [],
  );
  return useQuery<SignaturePulse, Error, SignaturePulseViewModel>({
    queryKey: ['signature-pulse'],
    queryFn: getSignaturePulse,
    staleTime: 30_000,
    select,
  });
}
