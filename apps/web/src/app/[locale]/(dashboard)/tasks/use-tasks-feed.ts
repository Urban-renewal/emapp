'use client';

import { useEffect, useState } from 'react';

import { useTaskList } from '@/hooks/use-tasks';
import type { TaskViewModel } from '@/models/task.vm';

/** One keyset page of the tasks feed (mirrors the inbox `INBOX_PAGE_LIMIT`). A
 *  larger page than the legacy 25 so the situation-picture groups are populated
 *  in fewer round-trips, while "Show more" still accumulates the rest. */
export const TASKS_FEED_PAGE_LIMIT = 50;

/**
 * Accumulating tasks feed — the EXACT discipline of `useInboxFeed`
 * (`hooks/use-proposals.ts`), re-applied to the tasks list so the
 * situation-picture grouping (`groupByDueDate`) runs over the WHOLE loaded set,
 * NOT one keyset page at a time.
 *
 * The defect this fixes is the per-page-grouping illusion: with grouping done
 * page-by-page, an overdue task on page 2 would form a SECOND "overdue" section
 * under page 1's. By appending every page into one `acc` array BEFORE grouping,
 * a bucket (overdue / today / week / later) accumulates across pages into ONE
 * section with the combined count.
 *
 * Single source of truth: this COMPOSES the canonical `useTaskList` hook (same
 * query key, same adapter, same dehydrated-cache seed) — it does NOT re-fetch or
 * re-implement the list. It only layers the cross-page accumulator on top.
 */
export function useTasksFeed() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [acc, setAcc] = useState<TaskViewModel[]>([]);
  const [exhausted, setExhausted] = useState(false);

  const list = useTaskList({ limit: TASKS_FEED_PAGE_LIMIT, cursor });
  const data = list.data;

  // Append each freshly-loaded page into the accumulator, de-duped by id (a
  // keyset boundary can re-deliver a row; never double-count it in a bucket).
  useEffect(() => {
    if (!data) return;
    setAcc((prev) => {
      const seen = new Set(prev.map((task) => task.id));
      const next = [...prev];
      for (const task of data.items) if (!seen.has(task.id)) next.push(task);
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
    page: data?.page,
    loadMore: () => {
      if (data?.page.has_more && data.page.cursor) setCursor(data.page.cursor);
    },
    retry: () => void list.refetch(),
    /** Re-walk the feed from page 1 (the accumulator is append-only). */
    reset: () => {
      setCursor(undefined);
      setAcc([]);
      setExhausted(false);
    },
  };
}
