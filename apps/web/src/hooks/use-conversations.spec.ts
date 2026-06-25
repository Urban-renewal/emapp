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
  useConversationsUnreadCount,
  useMarkConversationRead,
  useSendMessage,
} from './use-conversations';

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

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
