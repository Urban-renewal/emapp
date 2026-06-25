/**
 * `useApproveProposal` / `useRejectProposal` — TEST-AUTHOR (hook-config pattern).
 *
 * The Approval Inbox's two one-click verbs are optimistic-remove mutations: the
 * row vanishes the instant the user clicks, rolls back on error, and reconciles
 * on settle. These pins use the repo's hook-config pattern (mock the api layer +
 * `useQueryClient`, invoke the hook to read the `useMutation` config object).
 *
 * Pins:
 *   - APPROVE calls `approveProposal(id)` (the idempotent, action-applying POST).
 *   - REJECT calls `rejectProposal(id)` (the dismiss POST).
 *   - onMutate cancels + snapshots the proposals cache and OPTIMISTICALLY
 *     removes the row from every cached list page.
 *   - onError restores the snapshot (a failed approve leaves the row actionable
 *     — M2: per-item, never silently dropped).
 *   - onSettled invalidates the proposals root key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const approveProposal = vi.fn();
const rejectProposal = vi.fn();

vi.mock('@/lib/api/proposals', () => ({
  approveProposal: (...args: unknown[]) => approveProposal(...args),
  rejectProposal: (...args: unknown[]) => rejectProposal(...args),
  listProposals: vi.fn(),
  proposalsPendingCount: vi.fn(),
}));

vi.mock('@/lib/locale', () => ({ useDisplayLocale: () => 'he' }));

// TanStack mock — useMutation returns its config object so the spec can drive
// mutationFn / onMutate / onError / onSettled directly (no React runtime).
const cancelQueries = vi.fn(() => Promise.resolve());
const getQueriesData = vi.fn();
const setQueriesData = vi.fn();
const setQueryData = vi.fn();
const invalidateQueries = vi.fn();
const qc = { cancelQueries, getQueriesData, setQueriesData, setQueryData, invalidateQueries };

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => qc,
  useMutation: (config: unknown) => config,
  useQuery: () => ({}),
}));

const PROPOSALS_KEY = ['proposals'];

interface MutationHook {
  mutationFn: (id: string) => Promise<unknown>;
  onMutate: (id: string) => Promise<{ prev: unknown }>;
  onError: (e: unknown, id: string, ctx: { prev: [readonly unknown[], unknown][] }) => void;
  onSettled: () => void;
}

async function loadApprove(): Promise<MutationHook> {
  const { useApproveProposal } = await import('./use-proposals');
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useApproveProposal() as unknown as MutationHook;
}
async function loadReject(): Promise<MutationHook> {
  const { useRejectProposal } = await import('./use-proposals');
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useRejectProposal() as unknown as MutationHook;
}

const PAGE = {
  items: [
    { id: 'p-1', kind: 'signature_request.reissue' },
    { id: 'p-2', kind: 'signature_request.reissue' },
  ],
  page: { limit: 25, cursor: null, has_more: false },
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useApproveProposal', () => {
  it('1) mutationFn calls approveProposal(id)', async () => {
    approveProposal.mockResolvedValue({ id: 'p-1', status: 'applied' });
    const hook = await loadApprove();
    await hook.mutationFn('p-1');
    expect(approveProposal).toHaveBeenCalledWith('p-1');
    expect(rejectProposal).not.toHaveBeenCalled();
  });

  it('2) onMutate cancels, snapshots, and optimistically removes the row', async () => {
    getQueriesData.mockReturnValue([[['proposals', 'list', {}, 'he'], PAGE]]);
    const hook = await loadApprove();
    const ctx = await hook.onMutate('p-1');

    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: PROPOSALS_KEY });
    // The optimistic updater removes p-1, keeps p-2.
    const updater = setQueriesData.mock.calls[0]![1] as (old: typeof PAGE) => typeof PAGE;
    const next = updater(PAGE);
    expect(next.items.map((i) => i.id)).toEqual(['p-2']);
    expect(ctx.prev).toBeDefined();
  });

  it('3) onError restores every snapshotted cache entry (failed approve stays actionable)', async () => {
    const hook = await loadApprove();
    const key = ['proposals', 'list', {}, 'he'] as const;
    hook.onError(new Error('boom'), 'p-1', { prev: [[key, PAGE]] });
    expect(setQueryData).toHaveBeenCalledWith(key, PAGE);
  });

  it('4) onSettled invalidates the proposals root key', async () => {
    const hook = await loadApprove();
    hook.onSettled();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: PROPOSALS_KEY });
  });
});

describe('useRejectProposal', () => {
  it('5) mutationFn calls rejectProposal(id), never approve', async () => {
    rejectProposal.mockResolvedValue({ id: 'p-1', status: 'rejected' });
    const hook = await loadReject();
    await hook.mutationFn('p-1');
    expect(rejectProposal).toHaveBeenCalledWith('p-1');
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it('6) onMutate optimistically removes the rejected row too', async () => {
    getQueriesData.mockReturnValue([[['proposals', 'list', {}, 'he'], PAGE]]);
    const hook = await loadReject();
    await hook.onMutate('p-2');
    const updater = setQueriesData.mock.calls[0]![1] as (old: typeof PAGE) => typeof PAGE;
    expect(updater(PAGE).items.map((i) => i.id)).toEqual(['p-1']);
  });
});
