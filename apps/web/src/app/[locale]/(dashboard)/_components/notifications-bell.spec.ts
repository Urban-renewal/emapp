/**
 * Notifications bell — TRUE-COUNT badge guard (whole-set-view slice).
 *
 * The bug this guards: the bell badge used to count the ≤5 rows in the popover
 * and cap the label at the literal "5+" — a lie about magnitude (100 unread also
 * read "5+"). The fix drives the badge from the dedicated constant-time endpoint
 * (`useUnreadCount` → GET /notifications/unread-count), so it shows the REAL
 * org-wide total (capped only visually at "99+").
 *
 * Why render the real component (not a source grep): a source check is a
 * near-tautology. This seeds the two hooks the bell reads — `useNotificationBell`
 * (the ≤5 popover rows) and `useUnreadCount` (the true total) — and renders the
 * REAL `NotificationsBell` via `react-dom/server` (the repo's vitest env is
 * `node`, no DOM; `renderToStaticMarkup` returns an HTML string we assert on).
 * The badge text is therefore genuinely exercised: a regression back to the
 * page-local count would render "5"/"5+" and FAIL test 1.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationViewModel } from '@/models/notification.vm';

/** The two hook outputs the bell reads — mutable per test. */
let bellItems: NotificationViewModel[] = [];
let bellHasMore = false;
let trueUnread: number | undefined = 0;

vi.mock('@/hooks/use-notifications', () => ({
  useNotificationBell: () => ({
    data: { items: bellItems, page: { limit: 5, cursor: null, has_more: bellHasMore } },
    isError: false,
  }),
  useUnreadCount: () => ({ data: trueUnread }),
}));

// next-intl → passthrough so the badge's surrounding chrome renders; the badge
// VALUE is a raw number/`N+` string, not a translation, so it's asserted directly.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

vi.mock('@/components/ui/name-display', () => ({
  NameDisplay: ({ name }: { name: string }) => createElement('span', null, name),
}));

vi.mock('./notification-icon', () => ({
  NotificationIconTile: () => createElement('span'),
  actionVisual: () => ({ icon: () => createElement('span'), labelKey: 'open', primary: false }),
}));

import { NotificationsBell } from './notifications-bell';

function row(id: string, isRead: boolean): NotificationViewModel {
  return {
    id,
    type: 'task_assigned',
    typeLabel: 'task',
    title: 't',
    body: null,
    link: '/x',
    isRead,
    createdRelative: 'now',
    createdAtIso: '2026-06-25T00:00:00.000Z',
    actionKind: 'open',
    recencyBucket: 'today',
  };
}

function render(): string {
  return renderToStaticMarkup(createElement(NotificationsBell));
}

beforeEach(() => {
  bellItems = [];
  bellHasMore = false;
  trueUnread = 0;
});
afterEach(() => vi.clearAllMocks());

describe('NotificationsBell — badge shows the TRUE endpoint count', () => {
  it('1) shows the true org-wide total (42), NOT the page-local "5+" — even with 5 unread popover rows + has_more', () => {
    // The popover loaded 5 unread rows AND there are more pages — the OLD code
    // would render "5+". The endpoint says 42 unread org-wide.
    bellItems = Array.from({ length: 5 }, (_, i) => row(`u${i}`, false));
    bellHasMore = true;
    trueUnread = 42;
    const html = render();
    expect(html).toContain('42');
    expect(html).not.toContain('5+');
  });

  it('2) caps the DISPLAY at "99+" for very large totals (a render ceiling, not a lie)', () => {
    bellItems = Array.from({ length: 5 }, (_, i) => row(`u${i}`, false));
    bellHasMore = true;
    trueUnread = 230;
    const html = render();
    expect(html).toContain('99+');
    expect(html).not.toContain('230');
  });

  it('3) renders NO badge when the true count is 0 (even if popover rows exist but are read)', () => {
    bellItems = [row('r0', true), row('r1', true)];
    trueUnread = 0;
    const html = render();
    // No "danger" pill — the badge is gated on `unreadCount > 0`.
    expect(html).not.toContain('var(--danger-600)');
  });

  it('4) is resilient while the count query is still loading (undefined → 0, no badge, no crash)', () => {
    bellItems = [row('u0', false)];
    bellHasMore = true;
    trueUnread = undefined; // query in-flight
    const html = render();
    expect(html).not.toContain('5+');
    // Bell still renders (the trigger button is present).
    expect(html).toContain('button');
  });
});
