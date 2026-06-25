'use client';

import type { Conversation, CreateConversation, Message } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  createConversation,
  getConversationsUnreadCount,
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
  type ConversationListPage,
  type MessageListPage,
} from '@/lib/api/conversations';

const CONVERSATIONS_KEY = ['conversations'] as const;

/** Page size for both accumulating feeds (list + thread). */
const LIST_LIMIT = 50;
const THREAD_LIMIT = 50;

/**
 * Append `incoming` onto `acc`, skipping any id already present — the canonical
 * accumulate-then-dedup primitive both feeds use for OLDER pages (matches the
 * notifications/documents feed shape). Returns the SAME array reference when
 * nothing new was added so React can bail out of a redundant re-render.
 */
export function accumulateById<T extends { id: string }>(acc: T[], incoming: T[]): T[] {
  const seen = new Set(acc.map((x) => x.id));
  let next: T[] | null = null;
  for (const x of incoming) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    (next ??= [...acc]).push(x);
  }
  return next ?? acc;
}

/**
 * Render order for an accumulating, LIVE-polled feed: the live (page-1) rows
 * FIRST — authoritative, so an updated unreadCount / lastMessage / new message
 * always wins — then the accumulated OLDER rows with any id already on page 1
 * removed (one copy per entity; no duplicate when page 1 grows to overlap an
 * older page). This is the single source of truth for "what the list shows".
 */
export function mergeLiveThenOlder<T extends { id: string }>(live: T[], older: T[]): T[] {
  const liveIds = new Set(live.map((x) => x.id));
  return [...live, ...older.filter((x) => !liveIds.has(x.id))];
}

/**
 * The conversation list — ONE page. No WebSocket infra in this MVP (no Redis),
 * so near-real-time = polling: refetch every 15s (and on window focus) so a new
 * thread / incoming message + its unread badge surface without a manual reload.
 * Pass a `cursor` to fetch an OLDER page (the accumulating feed below walks it).
 */
export function useConversationList(
  query: { limit?: number; cursor?: string } = {},
  opts: { enabled?: boolean } = {},
) {
  return useQuery<ConversationListPage, Error>({
    queryKey: [...CONVERSATIONS_KEY, 'list', query],
    queryFn: () => listConversations(query),
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled: opts.enabled ?? true,
  });
}

/**
 * The conversation list as an ACCUMULATING feed — same canonical accumulate-then-
 * dedup shape as the documents `useAllDocumentsFeed` / notifications
 * `useNotificationsFeed` (one pattern; reused, not re-invented), reusing the BE's
 * existing keyset `has_more`/`cursor` so conversation #51+ is reachable instead
 * of capped at the first page.
 *
 * Adapted for this surface's LIVE polling: page 1 stays the polled query (new
 * threads + unread badges surface), and its rows are MERGED BY ID over the
 * accumulator on every poll (so an updated unreadCount / lastMessage / recency
 * refreshes in place) — older pages are appended as the user loads more. A bare
 * append-only accumulator (the notifications/documents lists don't poll) would
 * have shown a stale page-1 forever.
 */
export function useConversationsFeed() {
  // The keyset cursor of the OLDEST page we've loaded (undefined = page 1 only).
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Older pages (page 2+), append-only by id. Page 1 is the live polled query.
  const [olderAcc, setOlderAcc] = useState<Conversation[]>([]);
  const [exhausted, setExhausted] = useState(false);

  const page1 = useConversationList({ limit: LIST_LIMIT });
  // The page currently being fetched for "load more". DISABLED until the user
  // loads more (cursor set) so there is no redundant page-1 duplicate fetch.
  const olderPage = useConversationList(
    { limit: LIST_LIMIT, cursor },
    { enabled: cursor !== undefined },
  );

  useEffect(() => {
    if (cursor === undefined) return;
    const data = olderPage.data;
    if (!data) return;
    setOlderAcc((prev) => accumulateById(prev, data.items));
    if (!data.page.has_more) setExhausted(true);
  }, [cursor, olderPage.data]);

  // Render = the live page-1 rows FIRST (authoritative, deduped), then the
  // accumulated older pages with any id already on page 1 removed. One source
  // of truth per conversation; page-1's fresher copy always wins.
  const items = useMemo<Conversation[]>(
    () => mergeLiveThenOlder(page1.data?.items ?? [], olderAcc),
    [page1.data, olderAcc],
  );

  // has_more comes from whichever page is the current tail: before any "load
  // more" it's page 1; after, it's the last older page we fetched.
  const tailHasMore =
    cursor === undefined ? page1.data?.page.has_more : olderPage.data?.page.has_more;
  const tailCursor = cursor === undefined ? page1.data?.page.cursor : olderPage.data?.page.cursor;
  const canLoadMore = !exhausted && Boolean(tailHasMore);

  return {
    items,
    isLoading: page1.isLoading,
    isError: page1.isError,
    isExhausted: exhausted,
    isFetchingMore: cursor !== undefined && olderPage.isFetching,
    canLoadMore,
    loadMore: () => {
      if (tailHasMore && tailCursor) setCursor(tailCursor);
    },
    retry: () => void page1.refetch(),
  };
}

/**
 * Messages of the OPEN thread — ONE page. Polled faster (8s) than the list
 * because it's the focused surface; disabled until a conversation is selected.
 * Pass a `cursor` to walk OLDER messages (the accumulating feed below).
 */
export function useMessages(
  conversationId: string | undefined,
  query: { cursor?: string } = {},
  opts: { enabled?: boolean } = {},
) {
  return useQuery<MessageListPage, Error>({
    queryKey: [...CONVERSATIONS_KEY, 'messages', conversationId, query],
    queryFn: () => {
      if (!conversationId) throw new Error('useMessages requires a conversationId');
      return listMessages(conversationId, { limit: THREAD_LIMIT, ...query });
    },
    enabled: Boolean(conversationId) && (opts.enabled ?? true),
    staleTime: 5_000,
    refetchInterval: 8_000,
  });
}

/**
 * The OPEN thread's messages as an ACCUMULATING feed — same canonical shape as
 * above. The BE returns the newest THREAD_LIMIT first (keyset by created_at,id
 * DESC); page 1 stays the live polled query so new incoming messages arrive,
 * and "load older" walks the cursor BACK through history, appending older
 * messages (deduped by id). RESETS whenever the open conversation switches.
 *
 * `items` is server order (newest → oldest); the page reverses it for the
 * chronological render. A merge-by-id over page 1 keeps the newest window fresh.
 */
export function useMessagesFeed(conversationId: string | undefined) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [olderAcc, setOlderAcc] = useState<Message[]>([]);
  const [exhausted, setExhausted] = useState(false);

  // Reset the accumulation whenever the open conversation changes.
  useEffect(() => {
    setCursor(undefined);
    setOlderAcc([]);
    setExhausted(false);
  }, [conversationId]);

  const page1 = useMessages(conversationId);
  // Older history — DISABLED until the user clicks "load older" (cursor set), so
  // no redundant page-1 duplicate fetch and nothing runs before a thread opens.
  const olderPage = useMessages(conversationId, { cursor }, { enabled: cursor !== undefined });

  useEffect(() => {
    if (cursor === undefined) return;
    const data = olderPage.data;
    if (!data) return;
    setOlderAcc((prev) => accumulateById(prev, data.items));
    if (!data.page.has_more) setExhausted(true);
  }, [cursor, olderPage.data]);

  // Live newest window first, then older history (page-1 ids removed so a
  // message can't appear twice). One copy per message; page 1's is authoritative.
  const items = useMemo<Message[]>(
    () => mergeLiveThenOlder(page1.data?.items ?? [], olderAcc),
    [page1.data, olderAcc],
  );

  const tailHasMore =
    cursor === undefined ? page1.data?.page.has_more : olderPage.data?.page.has_more;
  const tailCursor = cursor === undefined ? page1.data?.page.cursor : olderPage.data?.page.cursor;
  const canLoadMore = !exhausted && Boolean(tailHasMore);

  return {
    items,
    isLoading: page1.isLoading,
    isError: page1.isError,
    isExhausted: exhausted,
    isFetchingOlder: cursor !== undefined && olderPage.isFetching,
    canLoadMore,
    loadOlder: () => {
      if (tailHasMore && tailCursor) setCursor(tailCursor);
    },
  };
}

/**
 * The TRUE org-wide unread total across ALL the caller's conversations — the
 * dedicated constant-time endpoint (mirrors notifications `useUnreadCount`), NOT
 * a page-local sum of the loaded rows. Unblocks a future nav badge; shares the
 * CONVERSATIONS_KEY root so the mutations' invalidation refreshes it for free.
 */
export function useConversationsUnreadCount() {
  return useQuery<number, Error>({
    queryKey: [...CONVERSATIONS_KEY, 'unread-count'],
    queryFn: getConversationsUnreadCount,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useCreateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateConversation) => createConversation(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });
}

export function useSendMessage(conversationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => {
      if (!conversationId) throw new Error('useSendMessage requires a conversationId');
      return sendMessage(conversationId, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...CONVERSATIONS_KEY, 'messages', conversationId] });
      qc.invalidateQueries({ queryKey: [...CONVERSATIONS_KEY, 'list'] });
      qc.invalidateQueries({ queryKey: [...CONVERSATIONS_KEY, 'unread-count'] });
    },
  });
}

export function useMarkConversationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => markConversationRead(conversationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...CONVERSATIONS_KEY, 'list'] });
      qc.invalidateQueries({ queryKey: [...CONVERSATIONS_KEY, 'unread-count'] });
    },
  });
}
