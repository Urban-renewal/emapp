'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { NameDisplay } from '@/components/ui/name-display';
import { useNotificationBell } from '@/hooks/use-notifications';

import { actionVisual, NotificationIconTile } from './notification-icon';

/**
 * Topbar bell — Phase 4c S3; V11 A.S11 reskin.
 *
 * Shows 5 most-recent notifications in a click-toggle popover. The
 * unread badge counts only the rows visible in the popover (BE pagination
 * caps at limit=5 here, so the badge says "5+" if all 5 are unread; the
 * precise org-wide unread count lives on the /notifications page).
 *
 * V11 A.S11 — adopts the partner `NotificationsPanel` (shell.jsx line
 * 179) visual:
 *   - 380px-wide rounded card with shadow
 *   - Header: "התראות" title + unread sub-count + "סמן הכל כנקרא"
 *   - Per-row tone-coded icon tile + title + body + time + unread dot
 *   - Footer: "הצג את כל ההתראות" link
 *
 * No SSE — Phase 5 (T3.N.1). The 30s `staleTime` + window-focus
 * refetch (workspace default) keep the bell within a minute of truth
 * during active use.
 *
 * Click-outside dismissal — no shadcn Popover dependency. The a11y
 * tree marks the panel `role="menu"` and the trigger `aria-expanded`.
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
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-muted"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white"
            style={{ background: 'var(--danger-600)' }}
          >
            {unreadLabel}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          dir="rtl"
          className="absolute z-50 flex max-h-[480px] w-[380px] flex-col overflow-hidden"
          style={{
            top: 'calc(100% + 8px)',
            insetInlineEnd: 0,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 14px 40px rgba(15,23,42,.16)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between"
            style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}
          >
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                {t('listTitle')}
              </div>
              {unreadCount > 0 && (
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {t('unreadSummary', { count: unreadCount })}
                </div>
              )}
            </div>
            {/* The "mark all read" lives on the full page (avoids
                duplicating mutation hooks here just for a popover). */}
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium"
              style={{ color: 'var(--navy-700)' }}
            >
              {t('viewAll')}
            </Link>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-auto">
            {isError ? (
              <p className="text-sm" style={{ padding: 16, color: 'var(--danger-700)' }}>
                {t('loadFailed')}
              </p>
            ) : items.length === 0 ? (
              <p
                className="text-center text-[13px]"
                style={{ padding: 36, color: 'var(--text-muted)' }}
              >
                {t('emptyBell')}
              </p>
            ) : (
              items.map((n, i) => {
                const isLast = i === items.length - 1;
                const rowStyle: React.CSSProperties = {
                  padding: '12px 16px',
                  borderBottom: isLast ? 0 : '1px solid var(--border)',
                  background: n.isRead
                    ? 'transparent'
                    : 'color-mix(in oklab, var(--navy-50) 50%, transparent)',
                };
                // The typed action affordance — same vocabulary as the full page
                // (one source of truth: notification-icon.tsx::actionVisual). On
                // the compact bell it reads as a quiet labelled chip telling the
                // user WHAT the click will let them do (upload / remind / …),
                // not just "a new thing happened".
                const action = actionVisual(n.actionKind);
                const ActionIcon = action.icon;
                const content = (
                  <div className="flex items-start gap-3" style={rowStyle}>
                    <NotificationIconTile type={n.type} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                        <NameDisplay name={n.title} />
                      </div>
                      {n.body && (
                        <div
                          className="mt-0.5 truncate text-xs"
                          style={{ color: 'var(--text-muted)', lineHeight: 1.4 }}
                        >
                          <NameDisplay name={n.body} />
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-[11px]">
                        <span style={{ color: 'var(--text-soft)' }}>{n.createdRelative}</span>
                        {n.link && (
                          <span
                            className="inline-flex items-center gap-1 font-medium"
                            style={{ color: 'var(--navy-700)' }}
                          >
                            <ActionIcon className="h-3 w-3" aria-hidden="true" />
                            {t(`action.${action.labelKey}`)}
                          </span>
                        )}
                      </div>
                    </div>
                    {!n.isRead && (
                      <span
                        aria-label={t('unreadAria')}
                        className="mt-1.5 inline-block shrink-0 rounded-full"
                        style={{ width: 8, height: 8, background: 'var(--danger-600)' }}
                      />
                    )}
                  </div>
                );
                if (n.link) {
                  return (
                    <Link
                      key={n.id}
                      href={n.link as `/${string}`}
                      onClick={() => setOpen(false)}
                      className="block transition-colors hover:bg-muted/40"
                    >
                      {content}
                    </Link>
                  );
                }
                return <div key={n.id}>{content}</div>;
              })
            )}
          </div>

          {/* Footer */}
          <div
            className="text-center"
            style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}
          >
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium"
              style={{ color: 'var(--navy-700)' }}
            >
              {t('showAll')}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
