'use client';

import type { NotificationType } from '@emapp/shared-types';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DataState } from '@/components/ui/data-state';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationList,
} from '@/hooks/use-notifications';
import type { NotificationRecencyBucket, NotificationViewModel } from '@/models/notification.vm';

import { actionVisual, NotificationIconTile } from '../_components/notification-icon';

/**
 * Notifications page — the ACTIONABLE work-surface (passive-log→work-surface).
 *
 * Council rule (§G-QA no-flat-surface): this is NOT a flat wall of rows. It is a
 * situation-picture:
 *   - GROUPED by recency (today / this-week / earlier) — section headers, with
 *     UNREAD floated to the top of each group so "what needs attention" reads
 *     first at any scale (hundreds of rows stay scannable).
 *   - Each row carries the RIGHT primary ACTION for its type (via the VM's
 *     type-derived `actionKind` → `actionVisual`): a document chase → "העלה כאן";
 *     a signature event → "שלח תזכורת"; a task/status/note → "בדוק"; a
 *     mention/message → "פתח שיחה". The action deep-links to the entity's
 *     canonical surface, which enforces its OWN authz (the notification never
 *     mutates directly, and is never a PII oracle).
 *   - EMPTY → a calm all-clear `<DataState>` reward, not a bare "אין התראות".
 *
 * Reuse (one source of truth): the action vocabulary lives in
 * `notification-icon.tsx::actionVisual` (shared with the bell); the mark-read
 * optimistic mutation is the EXISTING `useMarkNotificationRead` (unchanged); the
 * recency bucket + actionKind are derived ONCE in the adapter, never per surface.
 *
 * Filtering is client-side over the current page (server-side `?type=` is a BE
 * slice). The filter chips collapse wire types into user-facing categories.
 *
 * RLS: self-scoped — every row belongs to the current user; the BE guard is
 * authoritative and the FE pattern is identical across roles.
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

/** Render order of the recency sections (most-recent first). */
const BUCKET_ORDER: NotificationRecencyBucket[] = ['today', 'week', 'earlier'];

interface RecencyGroup {
  bucket: NotificationRecencyBucket;
  items: NotificationViewModel[];
  unreadCount: number;
}

/**
 * Group the (already filtered) rows by recency bucket, preserving the server's
 * newest-first order, then float UNREAD rows to the top of each bucket so the
 * attention-worthy items read first. Pure → easy to reason about + test.
 */
function groupByRecency(items: NotificationViewModel[]): RecencyGroup[] {
  const byBucket = new Map<NotificationRecencyBucket, NotificationViewModel[]>();
  for (const n of items) {
    const arr = byBucket.get(n.recencyBucket) ?? [];
    arr.push(n);
    byBucket.set(n.recencyBucket, arr);
  }
  const groups: RecencyGroup[] = [];
  for (const bucket of BUCKET_ORDER) {
    const bucketItems = byBucket.get(bucket);
    if (!bucketItems || bucketItems.length === 0) continue;
    // Stable partition: unread first, read after — each side keeps server order.
    const unread = bucketItems.filter((n) => !n.isRead);
    const read = bucketItems.filter((n) => n.isRead);
    groups.push({ bucket, items: [...unread, ...read], unreadCount: unread.length });
  }
  return groups;
}

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

  const groups = useMemo(() => groupByRecency(filteredItems), [filteredItems]);

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
      {/* Title + needs-attention summary + mark-all-read text-link */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="me-auto text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('listTitle')}
        </h1>
        {unreadCount > 0 && (
          <span
            className="inline-flex items-center rounded-full text-[11px] font-semibold"
            style={{
              padding: '3px 10px',
              background: 'var(--danger-50)',
              color: 'var(--danger-700)',
            }}
          >
            {t('needsAttentionCount', { count: unreadCount })}
          </span>
        )}
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

      {/* Grouped, attention-first list — or the calm all-clear reward. */}
      <DataState
        isLoading={false}
        isEmpty={groups.length === 0}
        emptyTitle={items.length === 0 ? t('allClearTitle') : t('allClearForFilterTitle')}
        emptyHint={items.length === 0 ? t('allClearHint') : t('allClearForFilterHint')}
        emptyAction={
          items.length === 0 ? (
            <CheckCircle2 className="h-6 w-6" style={{ color: 'var(--success-600)' }} aria-hidden />
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.bucket} aria-labelledby={`notif-group-${group.bucket}`}>
              <div className="mb-2 flex items-center gap-2 px-0.5">
                <h2
                  id={`notif-group-${group.bucket}`}
                  className="text-xs font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-soft)' }}
                >
                  {t(`group.${group.bucket}`)}
                </h2>
                {group.unreadCount > 0 && (
                  <span
                    className="inline-flex items-center rounded-full text-[10px] font-semibold"
                    style={{
                      padding: '1px 7px',
                      background: 'var(--danger-50)',
                      color: 'var(--danger-700)',
                    }}
                  >
                    {group.unreadCount}
                  </span>
                )}
              </div>
              <div className="card" style={{ overflow: 'hidden' }}>
                {group.items.map((n, i) => (
                  <NotificationRow
                    key={n.id}
                    n={n}
                    isLast={i === group.items.length - 1}
                    onMarkRead={onMarkRead}
                    markPending={markRead.isPending}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </DataState>

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

/**
 * One notification row — the icon tile + title/body/meta + the TYPED action
 * button + the mark-read control. The action button is the work-surface heart:
 * a deep-link to the entity's canonical surface labelled by the row's
 * `actionKind` ("העלה כאן" / "שלח תזכורת" / "בדוק" / "פתח שיחה" / "פתח"). When
 * the VM narrowed `link` to null (unsafe/absent) the action degrades to nothing
 * rather than a dead button.
 */
function NotificationRow({
  n,
  isLast,
  onMarkRead,
  markPending,
}: {
  n: NotificationViewModel;
  isLast: boolean;
  onMarkRead: (id: string) => void;
  markPending: boolean;
}) {
  const t = useTranslations('notifications');
  const action = actionVisual(n.actionKind);
  const ActionIcon = action.icon;
  const rowStyle: React.CSSProperties = {
    padding: '16px 20px',
    borderBottom: isLast ? 0 : '1px solid var(--border)',
    background: n.isRead ? 'transparent' : 'color-mix(in oklab, var(--navy-50) 50%, transparent)',
  };

  return (
    <div className="flex items-start gap-3.5" style={rowStyle}>
      <NotificationIconTile type={n.type} size={38} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {!n.isRead && (
            <span
              aria-label={t('unreadAria')}
              className="inline-block shrink-0 rounded-full"
              style={{ width: 8, height: 8, background: 'var(--danger-600)' }}
            />
          )}
          <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
            <NameDisplay name={n.title} />
          </div>
        </div>
        {n.body && (
          <div className="mt-1 text-[13px]" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
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
        </div>
      </div>

      {/* Right rail: the TYPED primary action + (when unread) mark-read. */}
      <div className="flex shrink-0 flex-col items-end gap-2">
        {n.link && (
          <Link
            href={n.link as `/${string}`}
            className={action.primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            aria-label={`${t(`action.${action.labelKey}`)} ${t('action.ariaSuffix', { title: n.title })}`}
          >
            <ActionIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t(`action.${action.labelKey}`)}</span>
          </Link>
        )}
        {!n.isRead && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onMarkRead(n.id)}
            disabled={markPending}
            aria-label={t('markRowReadAria')}
          >
            {t('markRead')}
          </Button>
        )}
      </div>
    </div>
  );
}
