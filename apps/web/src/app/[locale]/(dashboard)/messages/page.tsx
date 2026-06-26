'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Plus, Search, Send } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { NameDisplay } from '@/components/ui/name-display';
import {
  useConversationsFeed,
  useCreateConversation,
  useMarkConversationRead,
  useMessagesFeed,
  useSendMessage,
} from '@/hooks/use-conversations';
import { useSessionProfile } from '@/hooks/use-session';
import { listMembers } from '@/lib/api/members';
import { formatRelative } from '@/lib/format';
import { useDisplayLocale } from '@/lib/locale';

/**
 * Team messaging — the /messages surface (Slice 2). A two-pane chat: the
 * conversation list (by recency, with unread badges) and the open thread
 * (messages + composer). Participation-gated server-side; this page only
 * renders what the caller can see. Near-real-time via polling (the hooks set
 * refetchInterval) — no WebSocket infra in the MVP.
 */
export default function MessagesPage() {
  const t = useTranslations('messages');
  const locale = useDisplayLocale();
  const searchParams = useSearchParams();
  const me = useSessionProfile().data;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // find-at-scale (3.3) — client-side find over the LOADED conversation feed.
  // Controlled input (no native submit → no GET-fallback class); filters the
  // in-memory threads by resolved title (participant names / explicit title)
  // OR last-message preview, so a manager reaches a thread among 100+ without
  // scrolling. No new fetch — the feed is already loaded. Mirrors the
  // projects/owners search idiom (Search icon inset-end, type="search").
  const [threadQuery, setThreadQuery] = useState('');
  // Deep-link support: /messages?c=<conversationId> (the dashboard card links
  // here). Runs once per param change; user clicks override it after.
  useEffect(() => {
    const c = searchParams.get('c');
    if (c) setSelectedId(c);
  }, [searchParams]);

  // Side-load the members roster → resolve participant ids to names (Manager
  // sees all; an agent's roster may be narrower — we fall back to a short id).
  const membersQuery = useQuery({
    queryKey: ['members', 'list', { limit: 100 }, 'messages-side-load'],
    queryFn: () => listMembers({ limit: 100 }),
    staleTime: 30_000,
    retry: false,
  });
  const nameOf = useCallback(
    (id: string): string => {
      const found = membersQuery.data?.items.find((m) => m.userId === id);
      return found?.name ?? id.replace(/-/g, '').slice(0, 8);
    },
    [membersQuery.data],
  );

  // The conversation list, ACCUMULATED across keyset pages (reach thread #51+).
  const convFeed = useConversationsFeed();
  const conversations = convFeed.items;
  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  // The open thread's messages, ACCUMULATED (newest window + "load older").
  const messagesFeed = useMessagesFeed(selectedId ?? undefined);
  // The feed is newest-first (server order); render chronological (oldest → newest).
  const messages = useMemo(() => [...messagesFeed.items].reverse(), [messagesFeed.items]);

  // Mark the open thread read whenever it has unread messages.
  const markRead = useMarkConversationRead();
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (selectedId && selected && selected.unreadCount > 0) markReadMutate(selectedId);
  }, [selectedId, selected?.unreadCount, selected, markReadMutate]);

  // Composer.
  const [draft, setDraft] = useState('');
  const sendMut = useSendMessage(selectedId ?? undefined);
  async function onSend(): Promise<void> {
    const body = draft.trim();
    if (!body || !selectedId || sendMut.isPending) return;
    setDraft('');
    try {
      await sendMut.mutateAsync(body);
    } catch {
      setDraft(body); // restore on failure so the text isn't lost
    }
  }

  // New conversation: pick a member → start a 1:1.
  const [picking, setPicking] = useState(false);
  const createMut = useCreateConversation();
  async function startWith(userId: string): Promise<void> {
    setPicking(false);
    try {
      const conv = await createMut.mutateAsync({ participantIds: [userId] });
      setSelectedId(conv.id);
    } catch {
      // Surfaced via createMut.isError; swallow the rejection so it never
      // becomes an unhandled promise rejection (console-clean guardrail).
    }
  }

  const titleOf = useCallback(
    (c: { title: string | null; participantIds: string[] }): string => {
      if (c.title) return c.title;
      const others = c.participantIds.filter((id) => id !== me?.id);
      if (others.length === 0) return t('justYou');
      if (others.length === 1) return nameOf(others[0]!);
      return others.map(nameOf).join(', ');
    },
    [me?.id, nameOf, t],
  );

  // find-at-scale (3.3) — the conversation list narrowed by the find box. A
  // thread matches on its resolved title (participant names / explicit title)
  // OR its last-message preview. Empty box → the full feed (no-op filter).
  const visibleConversations = useMemo(() => {
    const q = threadQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      if (titleOf(c).toLowerCase().includes(q)) return true;
      const preview = c.lastMessage?.body;
      return preview ? preview.toLowerCase().includes(q) : false;
    });
  }, [conversations, threadQuery, titleOf]);

  // Auto-scroll to the latest message — keyed on the NEWEST message id (and the
  // thread switch), NOT on messages.length: "load older" prepends history and
  // grows the length, but must NOT yank the reader back to the bottom.
  const bottomRef = useRef<HTMLDivElement>(null);
  const newestId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [newestId, selectedId]);

  // Only ACCEPTED members can be added to a thread (the BE rejects pending
  // invitees with 400) — so the picker offers active teammates only.
  const otherMembers = (membersQuery.data?.items ?? []).filter(
    (m) => m.userId !== me?.id && m.acceptedAt !== null,
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('title')}
        </h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('subtitle')}
        </p>
      </div>

      <div className="grid h-[calc(100vh-12rem)] grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* ── Conversation list ─────────────────────────────────────────── */}
        <aside className="card flex min-h-0 flex-col overflow-hidden">
          <div className="card-hd flex items-center justify-between">
            <h3>{t('threads')}</h3>
            <div className="relative">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setPicking((v) => !v)}
                aria-expanded={picking}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>{t('newConversation')}</span>
              </button>
              {picking && (
                <div
                  className="absolute end-0 z-10 mt-1 max-h-72 w-60 overflow-auto rounded-lg border bg-white p-1 shadow-lg"
                  style={{ borderColor: 'var(--border)' }}
                  role="menu"
                >
                  {otherMembers.length === 0 ? (
                    <p className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {t('noMembers')}
                    </p>
                  ) : (
                    otherMembers.map((m) => (
                      <button
                        key={m.userId}
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm hover:bg-black/[.04]"
                        onClick={() => void startWith(m.userId)}
                        disabled={createMut.isPending}
                      >
                        <span className="avatar avatar-sm" aria-hidden="true">
                          {initials(m.name)}
                        </span>
                        <NameDisplay name={m.name} />
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* find-at-scale (3.3) — thread find box (renders once there's at
              least one thread to find). Filters the loaded feed by title or
              last-message preview; controlled input → no GET-fallback class. */}
          {!convFeed.isLoading && !convFeed.isError && conversations.length > 0 && (
            <div className="relative border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
              <Search
                className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2"
                style={{ color: 'var(--text-soft)', insetInlineEnd: 24 }}
                aria-hidden="true"
              />
              <input
                type="search"
                value={threadQuery}
                onChange={(e) => setThreadQuery(e.target.value)}
                placeholder={t('searchThreadsPlaceholder')}
                aria-label={t('searchThreadsPlaceholder')}
                className="input w-full text-sm"
                style={{ paddingInlineEnd: 34 }}
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {convFeed.isLoading ? (
              <p className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                {t('loading')}
              </p>
            ) : convFeed.isError ? (
              <p className="p-4 text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
                {t('loadFailed')}
              </p>
            ) : conversations.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
                <MessageSquare
                  className="h-10 w-10"
                  style={{ color: 'var(--text-soft)' }}
                  aria-hidden="true"
                />
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  {t('empty')}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t('emptyHint')}
                </p>
              </div>
            ) : visibleConversations.length === 0 ? (
              <p className="p-4 text-sm" style={{ color: 'var(--text-muted)' }} role="status">
                {t('noThreadResults')}
              </p>
            ) : (
              <ul>
                {visibleConversations.map((c) => {
                  const active = c.id === selectedId;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(c.id)}
                        className={`flex w-full items-center gap-3 border-b px-4 py-3 text-start transition-colors hover:bg-black/[.03] ${
                          active ? 'bg-black/[.04]' : ''
                        }`}
                        style={{ borderColor: 'var(--border)' }}
                        aria-current={active ? 'true' : undefined}
                      >
                        <span className="avatar" aria-hidden="true">
                          {initials(titleOf(c))}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span
                              className="truncate text-sm font-medium"
                              style={{ color: 'var(--text)' }}
                            >
                              <NameDisplay name={titleOf(c)} />
                            </span>
                            <span
                              className="shrink-0 text-[11px]"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {formatRelative(c.lastMessageAt, locale)}
                            </span>
                          </span>
                          <span className="flex items-center justify-between gap-2">
                            <span
                              className="truncate text-xs"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {c.lastMessage ? c.lastMessage.body : t('noMessagesYet')}
                            </span>
                            {c.unreadCount > 0 && (
                              <span className="badge badge-info shrink-0">{c.unreadCount}</span>
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {convFeed.canLoadMore && (
                  <li>
                    <button
                      type="button"
                      onClick={() => convFeed.loadMore()}
                      disabled={convFeed.isFetchingMore}
                      className="w-full px-4 py-3 text-center text-xs font-medium hover:bg-black/[.03] disabled:opacity-60"
                      style={{ color: 'var(--navy-700)' }}
                    >
                      {convFeed.isFetchingMore ? t('loading') : t('loadMoreThreads')}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Thread view ───────────────────────────────────────────────── */}
        <section className="card flex min-h-0 flex-col overflow-hidden">
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <MessageSquare
                className="h-12 w-12"
                style={{ color: 'var(--text-soft)' }}
                aria-hidden="true"
              />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {t('selectThread')}
              </p>
            </div>
          ) : (
            <>
              <div className="card-hd">
                <h3 className="truncate">
                  <NameDisplay name={titleOf(selected)} />
                </h3>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
                {messagesFeed.isLoading ? (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    {t('loading')}
                  </p>
                ) : messages.length === 0 ? (
                  <p className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                    {t('threadEmpty')}
                  </p>
                ) : (
                  <>
                    {messagesFeed.canLoadMore && (
                      <div className="flex justify-center pb-1">
                        <button
                          type="button"
                          onClick={() => messagesFeed.loadOlder()}
                          disabled={messagesFeed.isFetchingOlder}
                          className="rounded-full px-3 py-1 text-xs font-medium hover:bg-black/[.04] disabled:opacity-60"
                          style={{ color: 'var(--navy-700)' }}
                        >
                          {messagesFeed.isFetchingOlder ? t('loading') : t('loadOlderMessages')}
                        </button>
                      </div>
                    )}
                    {messages.map((m) => {
                      const mine = m.senderId === me?.id;
                      return (
                        <div
                          key={m.id}
                          className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                        >
                          {!mine && (
                            <span
                              className="mb-0.5 px-1 text-[11px]"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              <NameDisplay name={nameOf(m.senderId)} />
                            </span>
                          )}
                          <div
                            className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${
                              mine ? 'text-white' : 'bg-black/[.05]'
                            }`}
                            style={
                              mine ? { background: 'var(--navy-700)' } : { color: 'var(--text)' }
                            }
                          >
                            <span className="whitespace-pre-wrap break-words">
                              <NameDisplay name={m.body} />
                            </span>
                          </div>
                          <span
                            className="mt-0.5 px-1 text-[10px]"
                            style={{ color: 'var(--text-soft)' }}
                          >
                            {formatRelative(m.createdAt, locale)}
                          </span>
                        </div>
                      );
                    })}
                  </>
                )}
                <div ref={bottomRef} />
              </div>

              <form
                method="post"
                action=""
                className="flex items-end gap-2 border-t p-3"
                style={{ borderColor: 'var(--border)' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void onSend();
                }}
              >
                <textarea
                  className="input min-h-[42px] flex-1 resize-none"
                  rows={1}
                  placeholder={t('composerPlaceholder')}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void onSend();
                    }
                  }}
                  aria-label={t('composerPlaceholder')}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!draft.trim() || sendMut.isPending}
                  aria-label={t('send')}
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{t('send')}</span>
                </button>
              </form>
            </>
          )}
        </section>
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
