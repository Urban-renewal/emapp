'use client';

import type { NotificationType } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { toNotificationViewModels } from '@/adapters/notification';
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationListPage,
} from '@/lib/api/notifications';
import { useDisplayLocale } from '@/lib/locale';
import type { NotificationViewModel } from '@/models/notification.vm';

import { applyMarkAllRead, applyMarkRead } from './notifications-optimistic';
import {
  NOTIFICATIONS_KEY,
  notificationsListQueryKey,
  notificationsUnreadCountQueryKey,
} from './use-notifications.keys';

export { notificationsListQueryKey };

/** The page accumulator's page size — same 25 the RSC prefetch seeds. */
const FEED_LIMIT = 25;

/** Snapshot of every notifications-list cache entry, for optimistic rollback. */
type NotificationCacheSnapshot = [readonly unknown[], NotificationListPage | undefined][];

/**
 * Notifications data hooks.
 *
 * Polling (not SSE): the BE Notification schema doc states SSE push is
 * a Phase-5 integration (T3.N.1 — deferred). For Phase 4c the bell +
 * page rely on TanStack's `staleTime` (30s) + `refetchOnWindowFocus`
 * (true, the workspace default) for freshness. Manager-tier users
 * who keep the dashboard open in a background tab see updates on
 * focus return; the actively-viewed surface re-polls every 30s.
 *
 * Caching: ['notifications', 'list', query, locale] — the bell uses
 * `{ limit: 5 }` while /notifications uses `{ limit: 25, cursor }`,
 * so the two share NO cache (intentional — different page sizes
 * would otherwise overwrite each other).
 */

const BELL_LIMIT = 5;

export function useNotificationList(
  query: { limit?: number; cursor?: string; type?: NotificationType } = {},
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: NotificationListPage) => ({
      items: toNotificationViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    NotificationListPage,
    Error,
    { items: NotificationViewModel[]; page: NotificationListPage['page'] }
  >({
    queryKey: notificationsListQueryKey(query, locale),
    queryFn: () => listNotifications(query),
    staleTime: 30_000,
    select,
  });
}

/** Bell-icon variant — only the 5 most recent, separate cache slot. */
export function useNotificationBell() {
  return useNotificationList({ limit: BELL_LIMIT });
}

/**
 * The TRUE org-wide unread count — the dedicated constant-time, indexed endpoint
 * (`GET /notifications/unread-count`), NOT a page-local `filter(!isRead).length`
 * over the ≤25 rows the bell/page loaded. Drives the bell badge AND the page
 * header badge so both show the real total at scale (100s of unread → the real
 * number, never the old "5+" literal or a per-page slice). Shares the
 * `NOTIFICATIONS_KEY` root, so the mark-read mutations' invalidation refreshes
 * it for free. 30s staleTime mirrors the list (the ~30s bell poll cadence).
 */
export function useUnreadCount() {
  return useQuery<number, Error>({
    queryKey: notificationsUnreadCountQueryKey(),
    queryFn: getUnreadCount,
    staleTime: 30_000,
  });
}

/**
 * Mark-read with OPTIMISTIC UI: the row's unread state (and therefore the bell
 * badge + the "unread" filter) flips the instant the user clicks — no wait for
 * the server round-trip + refetch. `onMutate` snapshots every notifications
 * cache, applies the flip, and `onError` restores the snapshot; `onSettled`
 * reconciles with the server. cancelQueries first so an in-flight poll can't
 * clobber the optimistic value (TanStack optimistic-update recipe).
 */
/** A cached value is a notifications LIST page (vs the sibling unread-COUNT,
 *  a bare number) iff it has an `items` array. The two live under the same
 *  NOTIFICATIONS_KEY root, so the optimistic list transform MUST skip the count
 *  entry — running `applyMarkRead` on a number would throw inside setQueriesData. */
function isListPage(v: unknown): v is NotificationListPage {
  return typeof v === 'object' && v !== null && Array.isArray((v as { items?: unknown }).items);
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onMutate: async (id: string): Promise<{ prev: NotificationCacheSnapshot }> => {
      await qc.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const prev = qc.getQueriesData<NotificationListPage>({ queryKey: NOTIFICATIONS_KEY });
      // Decrement the true-count badge ONLY if this row is currently unread in
      // cache — so an idempotent re-click (row already read) doesn't double-count.
      const wasUnread = prev.some(
        ([, page]) => isListPage(page) && page.items.some((n) => n.id === id && n.readAt === null),
      );
      const at = new Date();
      qc.setQueriesData<NotificationListPage>({ queryKey: NOTIFICATIONS_KEY }, (old) =>
        isListPage(old) ? applyMarkRead(old, id, at) : old,
      );
      if (wasUnread) {
        qc.setQueryData<number>(notificationsUnreadCountQueryKey(), (c) =>
          typeof c === 'number' ? Math.max(0, c - 1) : c,
        );
      }
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onMutate: async (): Promise<{ prev: NotificationCacheSnapshot }> => {
      await qc.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const prev = qc.getQueriesData<NotificationListPage>({ queryKey: NOTIFICATIONS_KEY });
      const at = new Date();
      qc.setQueriesData<NotificationListPage>({ queryKey: NOTIFICATIONS_KEY }, (old) =>
        isListPage(old) ? applyMarkAllRead(old, at) : old,
      );
      // Optimistically zero the true-count badge too (it's a sibling under
      // NOTIFICATIONS_KEY); onSettled's invalidation reconciles with the server.
      qc.setQueryData<number>(notificationsUnreadCountQueryKey(), 0);
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

/**
 * The notifications PAGE feed — accumulate keyset pages so the recency grouping,
 * the type filter, and the page render reflect the WHOLE loaded set, not one
 * ≤25-row page (the per-page-grouping/filter illusion this fixes). Same
 * accumulate-then-dedup shape as the documents `useAllDocumentsFeed` /
 * `usePartyDocuments` (one canonical pattern; reused, not re-invented): append
 * each page's VMs into `acc` keyed by id, track `exhausted`, RESET whenever the
 * inputs (the server `type` filter) change.
 *
 * The `type` filter is pushed to the SERVER (additive `?type=` param), so a
 * narrowed feed walks every matching row org-wide — never a 25-row client slice
 * that silently missed matches on later pages. Page 1 (`{ limit, cursor:
 * undefined, type: undefined }`) hits the RSC-prefetched cache slot, so the
 * unfiltered first paint stays waterfall-free.
 */
export function useNotificationsFeed(type?: NotificationType) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [acc, setAcc] = useState<NotificationViewModel[]>([]);
  const [exhausted, setExhausted] = useState(false);

  // Reset the accumulation whenever the server-side filter changes.
  useEffect(() => {
    setCursor(undefined);
    setAcc([]);
    setExhausted(false);
  }, [type]);

  const page = useNotificationList({ limit: FEED_LIMIT, cursor, type });
  const data = page.data;

  useEffect(() => {
    if (!data) return;
    setAcc((prev) => {
      const seen = new Set(prev.map((n) => n.id));
      const next = [...prev];
      for (const n of data.items) if (!seen.has(n.id)) next.push(n);
      return next;
    });
    if (!data.page.has_more) setExhausted(true);
  }, [data]);

  const canLoadMore = !exhausted && Boolean(data?.page.has_more);
  const isLoadingFirst = page.isLoading && acc.length === 0 && cursor === undefined;
  const isFetchingMore = page.isFetching && cursor !== undefined;

  // `acc` already carries every loaded row in server order; expose it directly.
  const items = useMemo(() => acc, [acc]);

  return {
    items,
    /** Whether every page of this (optionally type-filtered) feed is loaded. */
    isExhausted: exhausted,
    isLoading: isLoadingFirst,
    isError: page.isError,
    isFetchingMore,
    canLoadMore,
    loadMore: () => {
      if (data?.page.has_more && data.page.cursor) setCursor(data.page.cursor);
    },
    retry: () => void page.refetch(),
  };
}
