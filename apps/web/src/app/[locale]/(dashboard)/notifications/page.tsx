'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationList,
} from '@/hooks/use-notifications';

/**
 * Notifications full-page list (RLS self-scoped — any org role sees
 * their own rows). Shows read + unread; un-read rows are visually
 * weighted heavier and carry a one-click mark-read action.
 */
export default function NotificationsPage() {
  const t = useTranslations('notifications');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useNotificationList({ limit: 25, cursor });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const items = list.data?.items ?? [];
  const unreadCount = items.filter((n) => !n.isRead).length;

  async function onMarkAll() {
    try {
      await markAll.mutateAsync();
    } catch {
      // Silent — the toast surface would be over-kill for an idempotent
      // self-action that the user can simply retry from the same button.
    }
  }

  async function onMarkRead(id: string) {
    try {
      await markRead.mutateAsync(id);
    } catch {
      // Same as above — silent fail; the row stays unread and the user
      // can click again.
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={onMarkAll} disabled={markAll.isPending}>
            {markAll.isPending ? t('markingAllRead') : t('markAllRead', { count: unreadCount })}
          </Button>
        )}
      </div>

      <ListPageShell
        isLoading={list.isLoading}
        isError={list.isError}
        itemCount={items.length}
        page={list.data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => list.refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((n) => (
            <li
              key={n.id}
              className={
                n.isRead
                  ? 'rounded-md border bg-card p-4 text-muted-foreground'
                  : 'rounded-md border border-primary/30 bg-primary/5 p-4'
              }
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {!n.isRead && (
                      <span
                        aria-label={t('unreadAria')}
                        className="inline-block h-2 w-2 rounded-full bg-primary"
                      />
                    )}
                    <span className="text-xs font-medium text-muted-foreground">{n.typeLabel}</span>
                    <span className="text-xs text-muted-foreground">· {n.createdRelative}</span>
                  </div>
                  <h2 className="mt-1 truncate text-sm font-semibold">
                    <NameDisplay name={n.title} />
                  </h2>
                  {n.body && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      <NameDisplay name={n.body} />
                    </p>
                  )}
                  {n.link && (
                    <Link
                      href={n.link as `/${string}`}
                      className="mt-1 inline-block text-xs font-medium underline"
                    >
                      {t('open')}
                    </Link>
                  )}
                </div>
                {!n.isRead && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onMarkRead(n.id)}
                    disabled={markRead.isPending}
                  >
                    {t('markRead')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}
