'use client';

import type { TabuExtraction } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createTabuExtraction,
  listTabuExtractions,
  runTabuExtraction,
} from '@/lib/api/tabu-extractions';

/**
 * 7c — TanStack wrappers for the tabu-extraction ENVELOPE lifecycle
 * (list / create / extract). The review surface (rows GET / row PATCH /
 * confirm) is intentionally NOT a query: those calls materialize decrypted
 * PII behind the per-session step-up unlock, so the component drives them
 * imperatively through `useStepUpUnlock().withStepUp` (the 403
 * `pii_step_up_required` → modal → retry loop) and keeps the rows in local
 * state — see `tabu-review-section.tsx`.
 */
const TABU_KEY = ['tabu-extractions'] as const;

export function useTabuExtractions(apartmentId: string | undefined, enabled = true) {
  return useQuery<TabuExtraction[]>({
    queryKey: [...TABU_KEY, 'list', apartmentId],
    queryFn: async () => {
      if (!apartmentId) throw new Error('useTabuExtractions requires apartmentId');
      const page = await listTabuExtractions(apartmentId, { limit: 25 });
      return page.items;
    },
    enabled: Boolean(apartmentId) && enabled,
    staleTime: 30_000,
  });
}

export function useCreateTabuExtraction(apartmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => createTabuExtraction(apartmentId, { documentId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TABU_KEY });
    },
  });
}

export function useRunTabuExtraction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runTabuExtraction(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TABU_KEY });
    },
  });
}

export { TABU_KEY };
