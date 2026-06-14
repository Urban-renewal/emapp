import type { NotificationListPage } from '@/lib/api/notifications';

/**
 * Pure optimistic cache transforms for notification mark-read (extracted from
 * the hook so they are unit-testable without a QueryClient). Both return a NEW
 * page (immutable — never mutate the cached object in place, or TanStack can't
 * tell the data changed) and only touch UNREAD rows, so a re-applied or
 * double-fired mutation is a no-op on already-read rows.
 *
 * `at` is passed in (not `new Date()` here) so the hook controls the timestamp
 * and tests stay deterministic.
 */
export function applyMarkRead(
  page: NotificationListPage,
  id: string,
  at: Date,
): NotificationListPage {
  return {
    ...page,
    items: page.items.map((n) => (n.id === id && n.readAt === null ? { ...n, readAt: at } : n)),
  };
}

export function applyMarkAllRead(page: NotificationListPage, at: Date): NotificationListPage {
  return {
    ...page,
    items: page.items.map((n) => (n.readAt === null ? { ...n, readAt: at } : n)),
  };
}
