'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { NameDisplay } from '@/components/ui/name-display';
import { useNotificationBell } from '@/hooks/use-notifications';

/**
 * Topbar bell — Phase 4c S3.
 *
 * Shows 5 most-recent notifications in a click-toggle popover; an
 * unread badge on the bell icon counts only the rows visible in the
 * popover (BE pagination caps at limit=5 here, so the badge says
 * "5+" if the page is full and all are unread — the precise full-org
 * unread count is on the /notifications page).
 *
 * No SSE — Phase 5 (T3.N.1). The 30s `staleTime` + window-focus
 * refetch (workspace default) keep the bell within a minute of truth
 * during active use.
 *
 * Click-outside dismissal — no shadcn Popover dependency. The
 * accessibility tree marks the panel `role="menu"` and the trigger
 * `aria-expanded` to give screen readers the right context.
 */
export function NotificationsBell() {
  const t = useTranslations('notifications');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { data, isError } = useNotificationBell();
  const items = data?.items ?? [];
  const unreadCount = items.filter((n) => !n.isRead).length;
  const unreadLabel =
    unreadCount === 0
      ? ''
      : data?.page?.has_more && unreadCount === items.length
        ? '5+'
        : String(unreadCount);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={t('bellAria')}
        aria-expanded={open}
        aria-haspopup="menu"
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
            {unreadLabel}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute end-0 z-50 mt-2 w-80 rounded-md border bg-popover p-2 shadow-lg"
          dir="rtl"
        >
          <div className="flex items-center justify-between border-b p-2">
            <span className="text-sm font-semibold">{t('listTitle')}</span>
            <Link
              href="/notifications"
              className="text-xs font-medium underline"
              onClick={() => setOpen(false)}
            >
              {t('viewAll')}
            </Link>
          </div>
          {isError ? (
            <p className="p-3 text-sm text-destructive">{t('loadFailed')}</p>
          ) : items.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto py-1">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={
                    n.isRead
                      ? 'rounded-md p-2 hover:bg-muted'
                      : 'rounded-md bg-primary/5 p-2 hover:bg-primary/10'
                  }
                >
                  <div className="flex items-center gap-2">
                    {!n.isRead && (
                      <span
                        aria-hidden="true"
                        className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
                      />
                    )}
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {n.typeLabel}
                    </span>
                    <span className="text-[10px] text-muted-foreground">· {n.createdRelative}</span>
                  </div>
                  <p className="mt-1 truncate text-sm">
                    <NameDisplay name={n.title} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
