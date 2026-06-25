/**
 * use-notifications — optimistic TRUE-COUNT badge sync (whole-set-view slice).
 *
 * The unread-COUNT query (`['notifications','unread-count']` → a bare number) is
 * a SIBLING of the list pages under the same `['notifications']` root. The
 * mark-read / mark-all-read mutations call `setQueriesData({ queryKey:
 * NOTIFICATIONS_KEY }, …)`, which matches BOTH — so the list transform MUST skip
 * the number entry (running `applyMarkRead` on a number would throw) AND the
 * count must move optimistically so the bell/page badge updates instantly.
 *
 * Node-env (no DOM): we mock `useQueryClient` to return a REAL `QueryClient`,
 * seed it with a list page + a count entry, then invoke the mutation config's
 * `onMutate` directly (the hook returns the `useMutation(...)` object).
 */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotificationListPage } from '@/lib/api/notifications';

import {
  NOTIFICATIONS_KEY,
  notificationsListQueryKey,
  notificationsUnreadCountQueryKey,
} from './use-notifications.keys';

let qc: QueryClient;
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQueryClient: () => qc, useMutation: (config: unknown) => config };
});

vi.mock('@/lib/locale', () => ({ useDisplayLocale: () => 'he' }));

function listPage(items: { id: string; readAt: string | null }[]): NotificationListPage {
  return {
    items: items.map((i) => ({
      id: i.id,
      organizationId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      type: 'task_assigned',
      title: 't',
      body: null,
      link: '/x',
      metadata: {},
      readAt: i.readAt ? new Date(i.readAt) : null,
      createdAt: new Date('2026-06-25T00:00:00.000Z'),
    })) as NotificationListPage['items'],
    page: { limit: 25, cursor: null, has_more: false },
  };
}

afterEach(() => vi.clearAllMocks());

describe('mark-read keeps the TRUE unread-count badge in sync (number sibling)', () => {
  it('decrements the count entry AND leaves it a number (does not throw on the sibling)', async () => {
    qc = new QueryClient();
    const listKey = notificationsListQueryKey({ limit: 25 }, 'he');
    qc.setQueryData(listKey, listPage([{ id: 'a', readAt: null }]));
    qc.setQueryData(notificationsUnreadCountQueryKey(), 7);

    const { useMarkNotificationRead } = await import('./use-notifications');
    const m = useMarkNotificationRead() as unknown as {
      onMutate: (id: string) => Promise<unknown>;
    };
    await m.onMutate('a');

    // The count moved (7 → 6) and stayed a NUMBER (the transform skipped it).
    expect(qc.getQueryData(notificationsUnreadCountQueryKey())).toBe(6);
    // The list row flipped to read.
    const page = qc.getQueryData<NotificationListPage>(listKey);
    expect(page?.items[0]?.readAt).not.toBeNull();
  });

  it('does NOT double-decrement on an idempotent re-click (already-read row)', async () => {
    qc = new QueryClient();
    const listKey = notificationsListQueryKey({ limit: 25 }, 'he');
    qc.setQueryData(listKey, listPage([{ id: 'a', readAt: '2026-06-24T00:00:00.000Z' }]));
    qc.setQueryData(notificationsUnreadCountQueryKey(), 3);

    const { useMarkNotificationRead } = await import('./use-notifications');
    const m = useMarkNotificationRead() as unknown as {
      onMutate: (id: string) => Promise<unknown>;
    };
    await m.onMutate('a'); // row already read → count must NOT change.

    expect(qc.getQueryData(notificationsUnreadCountQueryKey())).toBe(3);
  });

  it('mark-all zeroes the count entry without throwing on the number sibling', async () => {
    qc = new QueryClient();
    const listKey = notificationsListQueryKey({ limit: 25 }, 'he');
    qc.setQueryData(
      listKey,
      listPage([
        { id: 'a', readAt: null },
        { id: 'b', readAt: null },
      ]),
    );
    qc.setQueryData(notificationsUnreadCountQueryKey(), 42);

    const { useMarkAllNotificationsRead } = await import('./use-notifications');
    const m = useMarkAllNotificationsRead() as unknown as {
      onMutate: () => Promise<unknown>;
    };
    await m.onMutate();

    expect(qc.getQueryData(notificationsUnreadCountQueryKey())).toBe(0);
    const page = qc.getQueryData<NotificationListPage>(listKey);
    expect(page?.items.every((n) => n.readAt !== null)).toBe(true);
  });

  it('the count query lives under the NOTIFICATIONS_KEY root (so invalidation reaches it)', () => {
    expect(notificationsUnreadCountQueryKey().slice(0, NOTIFICATIONS_KEY.length)).toEqual([
      ...NOTIFICATIONS_KEY,
    ]);
  });
});
