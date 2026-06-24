/**
 * Phase 4c S3 — pin the Notifications API client surface.
 *
 * Test IDs (D.33 mapping):
 *   T-4c-S3-API.1  list — envelope unwrap + cursor query string
 *   T-4c-S3-API.2  list — Zod rejects bad NotificationType
 *   T-4c-S3-API.3  markRead — POST body + 200 returns Notification
 *   T-4c-S3-API.4  markRead — 404 not_found surfaces
 *   T-4c-S3-API.5  readAll — POST + returns `{ updated: N }`
 *   T-4c-S3-API.6  readAll — Zod rejects mis-shaped (e.g. updated as string)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notifications';

interface StubResponse {
  status: number;
  body?: unknown;
}

function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse) {
  return vi.fn((url: string, init?: RequestInit) => {
    const r = handler(url, init);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () =>
        text === '' ? Promise.reject(new Error('invalid json')) : Promise.resolve(JSON.parse(text)),
    } as unknown as Response);
  });
}

const NOTIF = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
  type: 'task_assigned',
  title: 'משימה חדשה',
  body: null,
  link: '/tasks/abc',
  metadata: {},
  readAt: null,
  createdAt: '2026-05-20T10:00:00.000Z',
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('listNotifications', () => {
  it('T-4c-S3-API.1) builds /notifications?limit=25&cursor=X with envelope unwrap', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [NOTIF], page: { limit: 25, cursor: 'NEXT', has_more: true } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await listNotifications({ limit: 25, cursor: 'OPAQUE' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.type).toBe('task_assigned');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/v1/notifications?limit=25&cursor=OPAQUE',
    );
  });

  it('T-4c-S3-API.2) Zod rejects an unknown NotificationType', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: {
        data: [{ ...NOTIF, type: 'system_alert' }],
        page: { limit: 25, cursor: null, has_more: false },
      },
    })) as unknown as typeof fetch;
    await expect(listNotifications()).rejects.toThrow();
  });

  it('T-4c-S3-API.7) pushes the `type` filter to the SERVER query string', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [NOTIF], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await listNotifications({ limit: 25, type: 'signature_received' });
    // The filter must hit the BE (`?type=`), NOT be a 25-row client-side filter.
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('type=signature_received');
  });
});

describe('getUnreadCount', () => {
  it('T-4c-S3-API.8) GET /notifications/unread-count returns the TRUE count (not page-local)', async () => {
    const fetchSpy = stubFetch(() => ({ status: 200, body: { data: { count: 137 } } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const count = await getUnreadCount();
    expect(count).toBe(137);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/v1/notifications/unread-count');
  });

  it('T-4c-S3-API.9) Zod rejects a mis-shaped count (string)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: { count: 'many' } },
    })) as unknown as typeof fetch;
    await expect(getUnreadCount()).rejects.toThrow();
  });
});

describe('markNotificationRead', () => {
  it('T-4c-S3-API.3) POST /notifications/:id/read returns Notification', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: { ...NOTIF, readAt: '2026-05-22T10:00:00.000Z' } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await markNotificationRead(NOTIF.id);
    expect(r.readAt).toBeInstanceOf(Date);
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(`/api/v1/notifications/${NOTIF.id}/read`);
  });

  it('T-4c-S3-API.4) 404 not_found surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 404,
      body: { error: { code: 'not_found' } },
    })) as unknown as typeof fetch;
    await expect(markNotificationRead(NOTIF.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('markAllNotificationsRead', () => {
  it('T-4c-S3-API.5) POST /notifications/read-all returns { updated: N }', async () => {
    const fetchSpy = stubFetch(() => ({ status: 200, body: { data: { updated: 12 } } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await markAllNotificationsRead();
    expect(r.updated).toBe(12);
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/v1/notifications/read-all');
  });

  it('T-4c-S3-API.6) Zod rejects mis-shaped (updated as string)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: { updated: 'twelve' } },
    })) as unknown as typeof fetch;
    await expect(markAllNotificationsRead()).rejects.toThrow();
  });

  it('T-4c-S3-API.6b) Zod rejects negative `updated`', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: { updated: -1 } },
    })) as unknown as typeof fetch;
    await expect(markAllNotificationsRead()).rejects.toThrow();
  });
});
