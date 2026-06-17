'use client';

import type { NotificationType } from '@emapp/shared-types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationList,
} from '@/hooks/use-notifications';

import { NotificationIconTile } from '../_components/notification-icon';

/**
 * V11 A.S11 — Notifications page reskin per
 * `MEAPP_design/shell.jsx` ManagerNotificationsPage (lines 395-477).
 *
 * Adopts the partner pattern:
 *  - Filter pill chips (`הכל / לא נקראו / חתימות / משימות / מסמכים /
 *    הערות / אזכורים / ביטולים / סטטוס דירות`) wrapping over the page.
 *  - "Mark all read" as a navy text-link top-right (vs the prior
 *    outline button).
 *  - One `.card` wrapping a vertically-stacked list of rows, each
 *    row = tone-coded icon tile + title/body/time + unread dot.
 *
 * Mapping diff vs partner: our wire emits 7 `NotificationType` enums
 * (task_assigned, apartment_status_changed, document_uploaded,
 * signature_received, note_added, share_revoked, mention) instead of
 * the partner's `kind` field. Filter chips collapse multiple wire
 * types into a single user-facing category when natural (e.g.
 * "documents" = `document_uploaded`).
 *
 * Filtering is client-side — `useNotificationList` returns the
 * current page; server-side `?type=` is a BE slice. Empty-state copy
 * differs per filter ("no notifications in this category" vs the
 * absolute empty).
 *
 * RLS: self-scoped — any org role only sees their own rows. The BE
 * guard is authoritative; FE pattern is the same regardless of role.
 */

type FilterKey =
  | 'all'
  | 'unread'
  | 'signature_received'
  | 'task_assigned'
  | 'document_uploaded'
  | 'note_added'
  | 'mention'
  | 'apartment_status_changed'
  | 'share_revoked';

const FILTER_TO_TYPE: Record<Exclude<FilterKey, 'all' | 'unread'>, NotificationType> = {
  signature_received: 'signature_received',
  task_assigned: 'task_assigned',
  document_uploaded: 'document_uploaded',
  note_added: 'note_added',
  mention: 'mention',
  apartment_status_changed: 'apartment_status_changed',
  share_revoked: 'share_revoked',
};

export function NotificationsListClient() {
  const t = useTranslations('notifications');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<FilterKey>('all');

  const list = useNotificationList({ limit: 25, cursor });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const items = useMemo(() => list.data?.items ?? [], [list.data?.items]);
  const unreadCount = useMemo(() => items.filter((n) => !n.isRead).length, [items]);

  const filteredItems = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'unread') return items.filter((n) => !n.isRead);
    const targetType = FILTER_TO_TYPE[filter];
    return items.filter((n) => n.type === targetType);
  }, [items, filter]);

  async function onMarkAll() {
    try {
      await markAll.mutateAsync();
    } catch {
      // Silent — same as prior version. The user can retry from the same link.
    }
  }

  async function onMarkRead(id: string) {
    try {
      await markRead.mutateAsync(id);
    } catch {
      // Silent — row stays unread; the user can click again.
    }
  }

  if (list.isLoading) return <ListSkeleton rows={6} />;

  if (list.isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {t('loadFailed')}
        </p>
        <Button variant="outline" size="sm" onClick={() => list.refetch()}>
          {tp('retry')}
        </Button>
      </div>
    );
  }

  const filters: { key: FilterKey; label: string }[] = [
    { key: 'all', label: t('filter.all') },
    { key: 'unread', label: t('filter.unread') },
    { key: 'signature_received', label: t('filter.signatures') },
    { key: 'task_assigned', label: t('filter.tasks') },
    { key: 'document_uploaded', label: t('filter.documents') },
    { key: 'note_added', label: t('filter.notes') },
    { key: 'mention', label: t('filter.mentions') },
    { key: 'apartment_status_changed', label: t('filter.apartments') },
    { key: 'share_revoked', label: t('filter.shareRevoked') },
  ];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      {/* Title + filter chips + mark-all-read text-link */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="me-auto text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('listTitle')}
        </h1>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={onMarkAll}
            disabled={markAll.isPending}
            className="text-sm font-medium disabled:opacity-50"
            style={{
              color: 'var(--navy-700)',
              background: 'transparent',
              border: 0,
              cursor: markAll.isPending ? 'not-allowed' : 'pointer',
            }}
          >
            {markAll.isPending ? t('markingAllRead') : t('markAllRead', { count: unreadCount })}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className="text-xs font-medium transition-colors"
              style={{
                padding: '6px 12px',
                borderRadius: 999,
                border: `1px solid ${active ? 'var(--navy-900)' : 'var(--border)'}`,
                background: active ? 'var(--navy-900)' : 'var(--bg-surface)',
                color: active ? '#fff' : 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* List card */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {filteredItems.length === 0 ? (
          <div className="text-center text-sm" style={{ padding: 48, color: 'var(--text-muted)' }}>
            {items.length === 0 ? t('empty') : t('emptyForFilter')}
          </div>
        ) : (
          filteredItems.map((n, i) => {
            const isLast = i === filteredItems.length - 1;
            const rowStyle: React.CSSProperties = {
              padding: '16px 20px',
              borderBottom: isLast ? 0 : '1px solid var(--border)',
              background: n.isRead
                ? 'transparent'
                : 'color-mix(in oklab, var(--navy-50) 50%, transparent)',
            };
            return (
              <div key={n.id} className="flex items-start gap-3.5" style={rowStyle}>
                <NotificationIconTile type={n.type} size={38} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                    <NameDisplay name={n.title} />
                  </div>
                  {n.body && (
                    <div
                      className="mt-1 text-[13px]"
                      style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}
                    >
                      <NameDisplay name={n.body} />
                    </div>
                  )}
                  <div
                    className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]"
                    style={{ color: 'var(--text-soft)' }}
                  >
                    <span>{n.typeLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span>{n.createdRelative}</span>
                    {n.link && (
                      <>
                        <span aria-hidden="true">·</span>
                        <Link
                          href={n.link as `/${string}`}
                          className="font-medium underline"
                          style={{ color: 'var(--navy-700)' }}
                        >
                          {t('open')}
                        </Link>
                      </>
                    )}
                  </div>
                </div>
                {!n.isRead && (
                  <div className="flex flex-col items-end gap-2">
                    <span
                      aria-label={t('unreadAria')}
                      className="inline-block shrink-0 rounded-full"
                      style={{ width: 9, height: 9, background: 'var(--danger-600)' }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onMarkRead(n.id)}
                      disabled={markRead.isPending}
                    >
                      {t('markRead')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center gap-2">
        {list.data?.page?.has_more && list.data.page.cursor && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCursor(list.data?.page?.cursor ?? undefined)}
          >
            {tp('next')}
          </Button>
        )}
        {cursor && (
          <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
            {tp('resetToFirstPage')}
          </Button>
        )}
      </div>
    </div>
  );
}
