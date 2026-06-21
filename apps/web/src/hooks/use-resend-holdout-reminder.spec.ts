/**
 * HB-3 — `useResendHoldoutReminder` (TEST-AUTHOR, adversarial).
 *
 * The board-card per-name remind is a TWO-STEP mutation:
 *   1. RESOLVE the holdout owner's live pending request — the B4 holdout surface
 *      carries only `ownerId` (NEVER a signature-request id), so we look it up
 *      via `listSignatureRequests({ ownerId, status: 'pending', limit: 1 })`.
 *   2. RESEND that request — `resendSignatureRequest(id)` (idempotent re-mint).
 *
 * Pins:
 *   - the resolve query is scoped to the owner + pending-only,
 *   - the resend targets the RESOLVED request id (not the ownerId),
 *   - no live pending request → a typed `holdout_none_pending` ApiClientError
 *     (so the UI shows the calm stale-board copy, NOT a wire error),
 *   - onSuccess invalidates BOTH `['signature-pulse']` (the board) AND the
 *     signature-requests root key (the resent row's expiry moved).
 *
 * Harness: the repo's hook-config node pattern (mirrors
 * signature-requests-link.api.spec.ts) — mock the api layer + `useQueryClient`,
 * invoke the hook as a plain function to read the `useMutation` config it builds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api/errors';

const listSignatureRequests = vi.fn();
const resendSignatureRequest = vi.fn();

vi.mock('@/lib/api/signature-requests', () => ({
  listSignatureRequests: (...args: unknown[]) => listSignatureRequests(...args),
  resendSignatureRequest: (...args: unknown[]) => resendSignatureRequest(...args),
  // The hook module imports these too (other exported hooks use them); stub so
  // the module graph resolves under the node env.
  cancelSignatureRequest: vi.fn(),
  createSignatureCampaign: vi.fn(),
  createSignatureRequest: vi.fn(),
  getSignatureRequest: vi.fn(),
  retrieveSignatureLink: vi.fn(),
}));

const invalidateSpy = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
  // Return the config object so the spec can drive mutationFn / onSuccess.
  useMutation: (config: unknown) => config,
  useQuery: () => ({}),
}));

// `useDisplayLocale` is imported by the hook module (other hooks use it).
vi.mock('@/lib/locale', () => ({ useDisplayLocale: () => 'he' }));

interface ResendHook {
  mutationFn: (ownerId: string) => Promise<unknown>;
  onSuccess: () => void;
}

const PENDING_ROW = {
  id: 'req-99',
  organizationId: '22222222-2222-4222-8222-222222222222',
  documentId: '33333333-3333-4333-8333-333333333333',
  ownerId: 'owner-7',
  status: 'pending' as const,
  expiresAt: new Date('2026-06-30T10:00:00.000Z'),
  createdBy: '55555555-5555-4555-8555-555555555555',
  createdAt: new Date('2026-06-20T10:00:00.000Z'),
  signedAt: null,
  signedSignatureId: null,
  cancelledAt: null,
  cancelledBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

async function loadHook(): Promise<ResendHook> {
  const { useResendHoldoutReminder } = await import('./use-signature-requests');
  // `useMutation` is mocked to return its config object, so calling the hook
  // here just yields that config (no real React runtime) — the repo's
  // hook-config test pattern (see signature-requests-link.api.spec.ts).
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useResendHoldoutReminder() as unknown as ResendHook;
}

describe('useResendHoldoutReminder — resolve → resend', () => {
  it('1) resolves the owner pending request, then resends THAT request id', async () => {
    listSignatureRequests.mockResolvedValue({
      items: [PENDING_ROW],
      page: { limit: 1, cursor: null, has_more: false },
    });
    resendSignatureRequest.mockResolvedValue(PENDING_ROW);

    const hook = await loadHook();
    await hook.mutationFn('owner-7');

    // Resolve: scoped to the owner + pending only (never widens to all rows).
    expect(listSignatureRequests).toHaveBeenCalledWith({
      ownerId: 'owner-7',
      status: 'pending',
      limit: 1,
    });
    // Resend: targets the RESOLVED request id, NOT the ownerId.
    expect(resendSignatureRequest).toHaveBeenCalledWith('req-99');
    expect(resendSignatureRequest).not.toHaveBeenCalledWith('owner-7');
  });

  it('2) no live pending request → a typed holdout_none_pending ApiClientError', async () => {
    listSignatureRequests.mockResolvedValue({
      items: [],
      page: { limit: 1, cursor: null, has_more: false },
    });

    const hook = await loadHook();
    await expect(hook.mutationFn('owner-7')).rejects.toMatchObject({
      code: 'holdout_none_pending',
    });
    await expect(hook.mutationFn('owner-7')).rejects.toBeInstanceOf(ApiClientError);
    // The resend is NEVER attempted when there's nothing pending to chase.
    expect(resendSignatureRequest).not.toHaveBeenCalled();
  });

  it('3) onSuccess invalidates BOTH the board pulse AND the signature-requests key', async () => {
    const hook = await loadHook();
    hook.onSuccess();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['signature-pulse'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['signature-requests'] });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});
