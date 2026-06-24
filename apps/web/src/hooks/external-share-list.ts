'use client';

/**
 * External-share list hook — V13 X-S6/X-S7. The "active shares" query for the
 * activity / revoke panel. Mirrors the canonical TanStack list pattern
 * (`use-shares.ts`): a `select` runs the pure Wire→VM adapter, staleTime 30s.
 *
 * The BE `list` returns only NON-revoked grants (revoked_at IS NULL), so the
 * panel naturally shows live shares; a revoke invalidates this key and the row
 * disappears (the canonical optimistic-then-refetch flow, NOT a second list).
 */
import type { ExternalSharePartyType } from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toExternalShareViewModels, type ExternalShareViewModel } from '@/adapters/external-share';
import {
  listExternalShares,
  type ExternalShareListPage,
  type ListExternalSharesQuery,
} from '@/lib/api/external-shares';
import { useDisplayLocale } from '@/lib/locale';

export const EXTERNAL_SHARES_KEY = ['external-shares'] as const;

export interface ExternalShareListResult {
  items: ExternalShareViewModel[];
  page: ExternalShareListPage['page'];
}

export function useExternalShareList(
  query: ListExternalSharesQuery = {},
  options: { enabled?: boolean; partyType?: ExternalSharePartyType } = {},
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: ExternalShareListPage): ExternalShareListResult => ({
      // `now` is captured per-select so relative strings + countdown seeds are
      // fresh on each (re)fetch; the component ticks finer-grained from there.
      items: toExternalShareViewModels(data.items, locale, new Date()),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<ExternalShareListPage, Error, ExternalShareListResult>({
    queryKey: [...EXTERNAL_SHARES_KEY, 'list', query, options.partyType, locale],
    queryFn: () => listExternalShares({ ...query, partyType: options.partyType }),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    select,
  });
}
