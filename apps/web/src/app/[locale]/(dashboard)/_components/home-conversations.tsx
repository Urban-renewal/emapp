'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

import { NameDisplay } from '@/components/ui/name-display';
import { useConversationList } from '@/hooks/use-conversations';
import { useSessionProfile } from '@/hooks/use-session';
import { listMembers } from '@/lib/api/members';
import { formatRelative } from '@/lib/format';
import { useDisplayLocale } from '@/lib/locale';

/**
 * Dashboard "Recent conversations" card body (Slice 3). A live client island
 * embedded in the (server) ManagerHome card: the 5 most-recent threads the
 * actor participates in, with unread badges + last-message preview, each
 * deep-linking into /messages?c=<id>. Replaces the former "chat coming later"
 * stub now that team messaging is real. Polls via the shared hook.
 */
export function HomeConversations() {
  const t = useTranslations('messages');
  const locale = useDisplayLocale();
  const me = useSessionProfile().data;

  const convQuery = useConversationList({ limit: 5 });
  const items = (convQuery.data?.items ?? []).slice(0, 5);

  const membersQuery = useQuery({
    queryKey: ['members', 'list', { limit: 100 }, 'home-conv-side-load'],
    queryFn: () => listMembers({ limit: 100 }),
    staleTime: 30_000,
    retry: false,
  });

  const titleOf = useCallback(
    (c: { title: string | null; participantIds: string[] }): string => {
      if (c.title) return c.title;
      const others = c.participantIds.filter((id) => id !== me?.id);
      if (others.length === 0) return t('justYou');
      return others
        .map(
          (id) =>
            membersQuery.data?.items.find((m) => m.userId === id)?.name ??
            id.replace(/-/g, '').slice(0, 8),
        )
        .join(', ');
    },
    [me?.id, membersQuery.data, t],
  );

  if (convQuery.isLoading) {
    return (
      <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
        {t('loading')}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <MessageSquare
          className="h-9 w-9"
          style={{ color: 'var(--text-soft)' }}
          aria-hidden="true"
        />
        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          {t('empty')}
        </p>
        <Link href="/messages" className="btn btn-sm btn-primary mt-1">
          {t('openMessages')}
        </Link>
      </div>
    );
  }

  return (
    <div>
      <ul>
        {items.map((c) => (
          <li key={c.id}>
            <Link
              href={`/messages?c=${c.id}`}
              className="flex items-center gap-3 border-b px-4 py-2.5 transition-colors hover:bg-black/[.03]"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="avatar avatar-sm" aria-hidden="true">
                {initials(titleOf(c))}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium" style={{ color: 'var(--text)' }}>
                    <NameDisplay name={titleOf(c)} />
                  </span>
                  <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {formatRelative(c.lastMessageAt, locale)}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                    {c.lastMessage ? c.lastMessage.body : t('noMessagesYet')}
                  </span>
                  {c.unreadCount > 0 && (
                    <span className="badge badge-info shrink-0">{c.unreadCount}</span>
                  )}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="p-3 text-center">
        <Link
          href="/messages"
          className="text-xs font-medium underline"
          style={{ color: 'var(--navy-700)' }}
        >
          {t('viewAll')}
        </Link>
      </div>
    </div>
  );
}

/** 1–2 char initials for an avatar (letters only — no bidi-spoofable output). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0] ?? '') + (parts[1]![0] ?? '');
  return name.slice(0, 2);
}
