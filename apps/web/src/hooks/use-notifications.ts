'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toNotificationViewModels } from '@/adapters/notification';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationListPage,
} from '@/lib/api/notifications';
import { useDisplayLocale } from '@/lib/locale';
import type { NotificationViewModel } from '@/models/notification.vm';

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

const NOTIFICATIONS_KEY = ['notifications'] as const;
const BELL_LIMIT = 5;

export function useNotificationList(query: { limit?: number; cursor?: string } = {}) {
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
    queryKey: [...NOTIFICATIONS_KEY, 'list', query, locale],
    queryFn: () => listNotifications(query),
    staleTime: 30_000,
    select,
  });
}

/** Bell-icon variant — only the 5 most recent, separate cache slot. */
export function useNotificationBell() {
  return useNotificationList({ limit: BELL_LIMIT });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}
