/**
 * Conversations feed — accumulate primitives + unread-count/mutation wiring.
 *
 * The two accumulating feeds (`useConversationsFeed` / `useMessagesFeed`) reuse
 * the canonical accumulate-then-dedup shape (notifications `useNotificationsFeed`
 * / documents `useAllDocumentsFeed`), adapted for this surface's LIVE polling via
 * a merge-by-id over the live page-1 query. The merge + dedup logic is extracted
 * into pure helpers (`accumulateById`, `mergeLiveThenOlder`) so it has ONE source
 * of truth and is unit-testable under the repo's node test env (no DOM / no
 * renderHook). This spec pins:
 *   - accumulateById appends only NEW ids (keyset "load more"/"load older"),
 *     is order-stable, returns the same ref when nothing is added;
 *   - mergeLiveThenOlder keeps the live (page-1) copy authoritative + de-dups the
 *     overlap, so a re-polled unreadCount/lastMessage refreshes in place and a
 *     row never appears twice when page 1 grows to overlap an older page;
 *   - the unread-count query + the send/mark-read mutations invalidate the
 *     unread-count cache (the future nav badge stays honest).
 *
 * Harness: the repo's hook-config node pattern (mock the api layer +
 * `@tanstack/react-query`; invoke the query/mutation hooks as plain functions to
 * read the config they build). The accumulate hooks themselves use real React
 * state and are covered through their extracted pure helpers.
 */
import type { Message } from '@emapp/shared-types';
import { describe, expect, it, vi } from 'vitest';

const getConversationsUnreadCount = vi.fn();

vi.mock('@/lib/api/conversations', () => ({
  getConversationsUnreadCount: (...a: unknown[]) => getConversationsUnreadCount(...a),
  listConversations: vi.fn(),
  listMessages: vi.fn(),
  createConversation: vi.fn(),
  sendMessage: vi.fn(),
  markConversationRead: vi.fn(),
}));

const invalidateSpy = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
  useMutation: (config: unknown) => config,
  useQuery: (config: unknown) => config,
}));

import {
  accumulateById,
  mergeLiveThenOlder,
  sortMessagesNewestFirst,
  useConversationsUnreadCount,
  useMarkConversationRead,
  useSendMessage,
} from './use-conversations';

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

/** A message numbered by recency — higher n = newer (distinct created_at). */
const msg = (n: number): Message => ({
  id: `m-${String(n).padStart(4, '0')}`,
  conversationId: '22222222-2222-4222-8222-222222222222',
  senderId: '11111111-1111-4111-8111-111111111111',
  body: `#${n}`,
  createdAt: new Date(2026, 0, 1, 0, 0, n),
});
/** A descending (newest → oldest) page of messages n=hi..lo, like the BE keyset. */
const descPage = (lo: number, hi: number): Message[] => {
  const out: Message[] = [];
  for (let n = hi; n >= lo; n--) out.push(msg(n));
  return out;
};

describe('accumulateById (keyset "load more" / "load older")', () => {
  it('appends only ids not already present, preserving order', () => {
    const acc = [row('a'), row('b')];
    const next = accumulateById(acc, [row('b'), row('c'), row('d')]);
    expect(next.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns the SAME reference when every incoming id is a duplicate (no needless re-render)', () => {
    const acc = [row('a'), row('b')];
    const next = accumulateById(acc, [row('a'), row('b')]);
    expect(next).toBe(acc);
  });

  it('dedups duplicates WITHIN the incoming page too', () => {
    const next = accumulateById([], [row('a'), row('a'), row('b')]);
    expect(next.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('mergeLiveThenOlder (live page-1 authoritative + de-duped tail)', () => {
  it('puts live rows first, then older rows whose id is not already live', () => {
    const live = [row('a'), row('b')];
    const older = [row('b'), row('c'), row('d')];
    expect(mergeLiveThenOlder(live, older).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('the LIVE copy wins when the same id is in both (fresh unreadCount/lastMessage)', () => {
    const live = [row('a', { unreadCount: 3 })];
    const older = [row('a', { unreadCount: 0 }), row('b', { unreadCount: 1 })];
    const merged = mergeLiveThenOlder(live, older) as { id: string; unreadCount: number }[];
    expect(merged.find((x) => x.id === 'a')!.unreadCount).toBe(3);
    // and 'a' appears exactly once
    expect(merged.filter((x) => x.id === 'a')).toHaveLength(1);
  });

  it('handles an empty older accumulator (first page only)', () => {
    const live = [row('a'), row('b')];
    expect(mergeLiveThenOlder(live, []).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('sortMessagesNewestFirst (canonical keyset order: created_at DESC, id DESC)', () => {
  it('orders newest-first by created_at', () => {
    const out = sortMessagesNewestFirst([msg(1), msg(3), msg(2)]);
    expect(out.map((m) => m.body)).toEqual(['#3', '#2', '#1']);
  });

  it('breaks a same-instant tie by id DESC (matches the BE keyset tiebreak)', () => {
    const at = new Date(2026, 0, 1, 12, 0, 0);
    const a = { ...msg(1), id: 'm-aaaa', createdAt: at };
    const b = { ...msg(1), id: 'm-bbbb', createdAt: at };
    expect(sortMessagesNewestFirst([a, b]).map((m) => m.id)).toEqual(['m-bbbb', 'm-aaaa']);
  });

  it('does not mutate its input', () => {
    const input = [msg(1), msg(2)];
    sortMessagesNewestFirst(input);
    expect(input.map((m) => m.body)).toEqual(['#1', '#2']);
  });
});

describe('useMessagesFeed window-shift (older loaded + new arrivals cross the live-window boundary)', () => {
  // 100 messages exist (m1..m100, m100 newest); the live page is the newest 50.
  // The user loads older history, then 3 NEW messages arrive and push the newest-50
  // live window forward (now m103..m54), so the old boundary rows m51/m52/m53 fall
  // off page-1's tail. Before the fix they were in NEITHER the live window NOR the
  // fixed-boundary older accumulator and vanished from the thread until reopen.
  const page1T0 = descPage(51, 100); // newest 50 at load-older time: m100..m51
  const olderPageItems = descPage(1, 50); // "load older" fetches the next 50: m50..m1
  const page1T1 = descPage(54, 103); // after 3 arrivals the live window is m103..m54

  it('REPRODUCES the gap: the pre-fix fixed-boundary merge drops the boundary messages', () => {
    // Pre-fix behaviour: olderAcc only ever held the explicit older pages; page-1
    // rows were never absorbed, so a shifted window orphans m51..m53.
    const fixedBoundaryAcc = accumulateById([], olderPageItems); // m50..m1 only
    const rendered = mergeLiveThenOlder(page1T1, fixedBoundaryAcc);
    const ids = new Set(rendered.map((m) => m.id));
    expect(ids.has('m-0051')).toBe(false);
    expect(ids.has('m-0052')).toBe(false);
    expect(ids.has('m-0053')).toBe(false);
    expect(rendered).toHaveLength(100); // 103 exist, 3 silently missing
  });

  it('FIX: absorbing the live window into the accumulator + canonical sort keeps every message, once, in order', () => {
    // Compose the helpers exactly as useMessagesFeed does across the sequence:
    let olderAcc: Message[] = [];
    olderAcc = accumulateById(olderAcc, olderPageItems); // older-page effect: m50..m1
    olderAcc = accumulateById(olderAcc, page1T0); // absorb effect at load-older: + m100..m51
    olderAcc = accumulateById(olderAcc, page1T1); // absorb effect on the T1 poll: + m103..m101

    const items = sortMessagesNewestFirst(mergeLiveThenOlder(page1T1, olderAcc));

    // No message lost, none duplicated: all 103 present exactly once.
    expect(items).toHaveLength(103);
    expect(new Set(items.map((m) => m.id)).size).toBe(103);
    // The would-vanish boundary rows are present.
    for (const id of ['m-0051', 'm-0052', 'm-0053']) {
      expect(items.some((m) => m.id === id)).toBe(true);
    }
    // Rendered in the one canonical order (newest → oldest, contiguous m103..m1).
    expect(items.map((m) => m.id)).toEqual(descPage(1, 103).map((m) => m.id));
  });
});

interface QueryConfig {
  queryKey: readonly unknown[];
  queryFn: () => unknown;
}
interface MutationConfig {
  onSuccess: () => void;
}

describe('unread-count query + mutation invalidation (future nav badge honesty)', () => {
  it('the unread-count query is keyed under the conversations root and calls the dedicated endpoint', () => {
    getConversationsUnreadCount.mockResolvedValueOnce(7);
    const cfg = useConversationsUnreadCount() as unknown as QueryConfig;
    expect(cfg.queryKey).toEqual(['conversations', 'unread-count']);
    cfg.queryFn();
    expect(getConversationsUnreadCount).toHaveBeenCalledTimes(1);
  });

  it('sendMessage onSuccess invalidates the unread-count cache (so the badge re-counts)', () => {
    invalidateSpy.mockClear();
    const cfg = useSendMessage('11111111-1111-4111-8111-111111111111') as unknown as MutationConfig;
    cfg.onSuccess();
    const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['conversations', 'unread-count']);
  });

  it('markConversationRead onSuccess invalidates the unread-count cache', () => {
    invalidateSpy.mockClear();
    const cfg = useMarkConversationRead() as unknown as MutationConfig;
    cfg.onSuccess();
    const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['conversations', 'unread-count']);
  });
});
