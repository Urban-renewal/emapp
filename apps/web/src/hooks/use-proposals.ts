'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { toProposalViewModels } from '@/adapters/proposal';
import {
  approveProposal,
  listProposals,
  proposalsPendingCount,
  rejectProposal,
  type ListProposalsQuery,
  type ProposalListPage,
} from '@/lib/api/proposals';
import { useDisplayLocale } from '@/lib/locale';
import type { ProposalViewModel } from '@/models/proposal.vm';

import {
  PROPOSALS_KEY,
  proposalsListQueryKey,
  proposalsPendingCountQueryKey,
} from './use-proposals.keys';

export { proposalsListQueryKey, PROPOSALS_KEY };

/** The page size the inbox feed pages at (keyset). One source of truth so the
 *  list hook + the accumulate feed never drift. */
const INBOX_PAGE_LIMIT = 25;

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

/**
 * The HONEST inbox lead-line count — the org-wide PENDING total. Reads the
 * constant-time `GET /proposals/pending-count` endpoint (mirrors the
 * notifications unread-count pattern), NOT `items.length` over a ≤25 page (which
 * lied "25" at 80 pending). Nested under `PROPOSALS_KEY`, so the approve/reject
 * mutations' `invalidateQueries({ queryKey: PROPOSALS_KEY })` refreshes it in
 * lockstep with the list (one source of truth — the count + the feed move
 * together; no drift). 30s staleTime + window-focus refetch, like the list.
 */
export function useProposalsPendingCount(opts: { kind?: string } = {}) {
  const kind = opts.kind;
  return useQuery<{ count: number }, Error>({
    // `kind` mirrors the active list facet so the lead-line + honesty-line + feed
    // all derive from ONE kind-aware source (no "X מתוך Y" drift under a filter).
    queryKey: proposalsPendingCountQueryKey(kind ? { kind } : {}),
    queryFn: () => proposalsPendingCount(kind ? { kind } : {}),
    staleTime: 30_000,
  });
}

/**
 * Accumulate the inbox feed ACROSS keyset pages so the kind-grouping reflects
 * EVERY loaded proposal — not just the current 25-row page (the per-page-grouping
 * illusion: a kind's proposals split over a page boundary used to land in
 * different page-groups). SAME accumulate-then-dedup shape as the canonical
 * `useAllDocumentsFeed` (documents-list.client.tsx): append each page into `acc`
 * keyed by id, track `exhausted`, reset when the inputs change. The grouping +
 * the honesty line run over the ACCUMULATED set.
 *
 * `kind` optionally narrows server-side (the list endpoint's `?kind` filter), so
 * switching the kind facet resets + re-walks the filtered feed.
 */
export function useInboxFeed(opts: { kind?: string } = {}) {
  const locale = useDisplayLocale();
  const kind = opts.kind;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [acc, setAcc] = useState<ProposalViewModel[]>([]);
  const [exhausted, setExhausted] = useState(false);

  // Reset the accumulation whenever the QUERY (kind / locale) changes.
  useEffect(() => {
    setCursor(undefined);
    setAcc([]);
    setExhausted(false);
  }, [kind, locale]);

  const list = useProposalList({ limit: INBOX_PAGE_LIMIT, cursor, ...(kind ? { kind } : {}) });
  const data = list.data;

  useEffect(() => {
    if (!data) return;
    setAcc((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      const next = [...prev];
      for (const p of data.items) if (!seen.has(p.id)) next.push(p);
      return next;
    });
    if (!data.page.has_more) setExhausted(true);
  }, [data]);

  const canLoadMore = !exhausted && Boolean(data?.page.has_more);
  const isLoadingFirst = list.isLoading && acc.length === 0 && cursor === undefined;
  const isFetchingMore = list.isFetching && cursor !== undefined;

  return {
    items: acc,
    /** Whether ALL pages of the underlying feed have been loaded. */
    isExhausted: exhausted,
    isLoading: isLoadingFirst,
    isError: list.isError,
    error: list.error,
    isFetchingMore,
    canLoadMore,
    loadMore: () => {
      if (data?.page.has_more && data.page.cursor) setCursor(data.page.cursor);
    },
    retry: () => void list.refetch(),
    // After an approve/reject optimistically removes a row, RESET the
    // accumulation so the feed re-walks from page 1 (the accumulator is
    // append-only; a bare refetch would leave the actioned row lingering in
    // `acc`). Matches the documents feed's `onArchived` discipline.
    reset: () => {
      setCursor(undefined);
      setAcc([]);
      setExhausted(false);
    },
  };
}

/** Shared optimistic-remove mutation factory — APPROVE + REJECT both remove the
 *  row instantly and roll back on error. The only difference is the mutationFn.
 *  Generic over the result `TData` so a typed `mutateAsync` carries through (the
 *  approve mutation returns the `ProposalApproveResponse` incl. `delivery`; the
 *  caller reads the outcome to confirm the owner WAS re-contacted). */
function useRemoveOnSettle<TData>(mutationFn: (id: string) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation<TData, Error, string, { prev: ProposalCacheSnapshot }>({
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

/** APPROVE — replays the gated action; optimistic remove + rollback. Resolves to
 *  the `ProposalApproveResponse` so the caller can surface the `delivery` outcome
 *  (the legibility confirmation: owner re-contacted, on which channel — or why
 *  not). */
export function useApproveProposal() {
  return useRemoveOnSettle((id: string) => approveProposal(id));
}

/** REJECT — dismiss; optimistic remove + rollback. */
export function useRejectProposal() {
  return useRemoveOnSettle((id: string) => rejectProposal(id));
}
