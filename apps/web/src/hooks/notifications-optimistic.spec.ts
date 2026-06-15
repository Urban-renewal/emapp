import type { Notification } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import type { NotificationListPage } from '@/lib/api/notifications';

import { applyMarkAllRead, applyMarkRead } from './notifications-optimistic';

const AT = new Date('2026-06-14T12:00:00.000Z');

function notif(id: string, readAt: Date | null): Notification {
  return {
    id,
    type: 'apartment_status_changed',
    title: 't',
    body: 'b',
    link: `/apartments/${id}`,
    readAt,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  } as Notification;
}

function page(items: Notification[]): NotificationListPage {
  return { items, page: { limit: 25, cursor: null, has_more: false } };
}

describe('notifications optimistic cache transforms', () => {
  it('applyMarkRead flips ONLY the targeted unread row', () => {
    const before = page([notif('a', null), notif('b', null)]);
    const after = applyMarkRead(before, 'a', AT);
    expect(after.items.find((n) => n.id === 'a')?.readAt).toEqual(AT);
    expect(after.items.find((n) => n.id === 'b')?.readAt).toBeNull();
  });

  it('applyMarkRead is a no-op on an already-read row (idempotent)', () => {
    const already = new Date('2026-06-10T00:00:00.000Z');
    const before = page([notif('a', already)]);
    const after = applyMarkRead(before, 'a', AT);
    expect(after.items[0]?.readAt).toEqual(already); // not overwritten by AT
  });

  it('applyMarkRead does not mutate the input page or its items (immutable)', () => {
    const before = page([notif('a', null)]);
    const snapshotReadAt = before.items[0]?.readAt;
    applyMarkRead(before, 'a', AT);
    expect(before.items[0]?.readAt).toBe(snapshotReadAt ?? null); // original untouched
  });

  it('applyMarkAllRead flips every unread row, leaves read rows', () => {
    const read = new Date('2026-06-10T00:00:00.000Z');
    const before = page([notif('a', null), notif('b', read), notif('c', null)]);
    const after = applyMarkAllRead(before, AT);
    expect(after.items.find((n) => n.id === 'a')?.readAt).toEqual(AT);
    expect(after.items.find((n) => n.id === 'b')?.readAt).toEqual(read);
    expect(after.items.find((n) => n.id === 'c')?.readAt).toEqual(AT);
  });
});
