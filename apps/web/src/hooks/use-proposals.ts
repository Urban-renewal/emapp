'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toProposalViewModels } from '@/adapters/proposal';
import {
  approveProposal,
  listProposals,
  rejectProposal,
  type ListProposalsQuery,
  type ProposalListPage,
} from '@/lib/api/proposals';
import { useDisplayLocale } from '@/lib/locale';
import type { ProposalViewModel } from '@/models/proposal.vm';

import { PROPOSALS_KEY, proposalsListQueryKey } from './use-proposals.keys';

export { proposalsListQueryKey, PROPOSALS_KEY };

/** Snapshot of every proposals-list cache entry, for optimistic rollback. */
type ProposalCacheSnapshot = [readonly unknown[], ProposalListPage | undefined][];

/**
 * Approval-Inbox data hooks (Autonomous Master Plan, Phase 1).
 *
 * Polling: like notifications, freshness rides TanStack's `staleTime` (30s) +
 * `refetchOnWindowFocus` (the workspace default). A proposal that gets approved
 * / rejected / expired in another tab reconciles on focus return; the active
 * surface re-polls every 30s.
 *
 * APPROVE + REJECT both OPTIMISTICALLY REMOVE the row the instant the user
 * clicks (the Approval Inbox should feel one-click-and-gone), snapshot every
 * proposals cache for rollback on error, and reconcile on settle. The mutations
 * carry 0 retries (the workspace mutation default) — an approve that fails must
 * NOT silently re-fire a real action.
 */

/** Remove a proposal id from a cached list page (optimistic apply). */
function removeProposal(page: ProposalListPage, id: string): ProposalListPage {
  const items = page.items.filter((p) => p.id !== id);
  if (items.length === page.items.length) return page;
  return { ...page, items };
}

export function useProposalList(query: ListProposalsQuery = {}) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: ProposalListPage) => ({
      items: toProposalViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    ProposalListPage,
    Error,
    { items: ProposalViewModel[]; page: ProposalListPage['page'] }
  >({
    queryKey: proposalsListQueryKey(query, locale),
    queryFn: () => listProposals(query),
    staleTime: 30_000,
    select,
  });
}

/** Shared optimistic-remove mutation factory — APPROVE + REJECT both remove the
 *  row instantly and roll back on error. The only difference is the mutationFn. */
function useRemoveOnSettle(mutationFn: (id: string) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (id: string): Promise<{ prev: ProposalCacheSnapshot }> => {
      await qc.cancelQueries({ queryKey: PROPOSALS_KEY });
      const prev = qc.getQueriesData<ProposalListPage>({ queryKey: PROPOSALS_KEY });
      qc.setQueriesData<ProposalListPage>({ queryKey: PROPOSALS_KEY }, (old) =>
        old ? removeProposal(old, id) : old,
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: PROPOSALS_KEY });
    },
  });
}

/** APPROVE — replays the gated action; optimistic remove + rollback. */
export function useApproveProposal() {
  return useRemoveOnSettle((id: string) => approveProposal(id));
}

/** REJECT — dismiss; optimistic remove + rollback. */
export function useRejectProposal() {
  return useRemoveOnSettle((id: string) => rejectProposal(id));
}
