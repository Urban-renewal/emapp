/**
 * HB-5 — `useChaseHoldout` (TEST-AUTHOR, adversarial).
 *
 * The board-card per-name action is a STATE-AWARE one-click chase. It is a
 * two-step mutation:
 *   1. RESOLVE the holdout owner's live pending request — the B4 holdout surface
 *      carries only `ownerId` (NEVER a signature-request id), so we look it up
 *      via `listSignatureRequests({ ownerId, status: 'pending', limit: 1 })`.
 *   2a. If one exists → RESEND it (`resendSignatureRequest(id)`; idempotent
 *       re-mint) → returns 'resent'.
 *   2b. ELSE, if the holdout has a per-apartment signable document → CREATE a
 *       request against it (`createSignatureRequest({ documentId, ownerId })`)
 *       → 'created'. The doc is THIS holdout's OWN apartment agreement (HB-5
 *       fix) so an associated owner gets 201, not a 409.
 *   2c. ELSE (no pending AND no signable doc) → typed `holdout_none_pending`.
 *
 * Pins:
 *   - the resolve query is scoped to the owner + pending-only,
 *   - RESEND targets the RESOLVED request id (not the ownerId), and we do NOT
 *     create when a pending request already exists,
 *   - CREATE posts `{ documentId: signableDocumentId, ownerId }` when there is
 *     no pending request but a per-apartment signable doc, and we do NOT resend then,
 *   - no pending AND no signable doc → a typed `holdout_none_pending`
 *     ApiClientError (calm stale-board copy, NOT a wire error); neither
 *     resend nor create is attempted,
 *   - onSuccess invalidates BOTH `['signature-pulse']` (the board) AND the
 *     signature-requests root key.
 *
 * Harness: the repo's hook-config node pattern (mock the api layer +
 * `useQueryClient`, invoke the hook as a plain function to read the
 * `useMutation` config it builds).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api/errors';

const listSignatureRequests = vi.fn();
const resendSignatureRequest = vi.fn();
const createSignatureRequest = vi.fn();

vi.mock('@/lib/api/signature-requests', () => ({
  listSignatureRequests: (...args: unknown[]) => listSignatureRequests(...args),
  resendSignatureRequest: (...args: unknown[]) => resendSignatureRequest(...args),
  createSignatureRequest: (...args: unknown[]) => createSignatureRequest(...args),
  // The hook module imports these too (other exported hooks use them); stub so
  // the module graph resolves under the node env.
  cancelSignatureRequest: vi.fn(),
  createSignatureCampaign: vi.fn(),
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

interface ChaseHook {
  mutationFn: (input: { ownerId: string; signableDocumentId: string | null }) => Promise<unknown>;
  onSuccess: () => void;
}

// The per-apartment signable doc the create targets (this holdout's OWN apt doc).
const APT_DOC = '33333333-3333-4333-8333-333333333333';

// A delivery report where a channel ACTUALLY went out (email sent) → delivered.
const DELIVERED_REPORT = {
  email: { available: true, status: 'sent' as const, to: 'na***@x.test' },
  sms: { available: false, reason: 'no_phone_on_file' },
  whatsapp: { available: false, reason: 'no_phone_on_file' },
};
// A delivery report where NO channel went out (owner has no email AND no phone, or
// PII decrypt failed) → the request exists but NOTHING was sent (`didAnyChannelDeliver`
// is false). The toast MUST NOT claim "sent".
const NO_CHANNEL_REPORT = {
  email: { available: false, reason: 'no_email_on_file' },
  sms: { available: false, reason: 'no_phone_on_file' },
  whatsapp: { available: false, reason: 'no_phone_on_file' },
};
const SIGN_URL = 'https://app.test/sign/jwt-token';

const PENDING_ROW = {
  id: 'req-99',
  organizationId: '22222222-2222-4222-8222-222222222222',
  documentId: APT_DOC,
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

async function loadHook(): Promise<ChaseHook> {
  const { useChaseHoldout } = await import('./use-signature-requests');
  // `useMutation` is mocked to return its config object, so calling the hook
  // here just yields that config (no real React runtime) — the repo's
  // hook-config test pattern.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useChaseHoldout() as unknown as ChaseHook;
}

describe('useChaseHoldout — state-aware chase', () => {
  it('1) pending exists + channel delivered → resends THAT request id, returns {resent, delivered:true}, never creates', async () => {
    listSignatureRequests.mockResolvedValue({
      items: [PENDING_ROW],
      page: { limit: 1, cursor: null, has_more: false },
    });
    resendSignatureRequest.mockResolvedValue({
      request: PENDING_ROW,
      signUrl: SIGN_URL,
      delivery: DELIVERED_REPORT,
    });

    const hook = await loadHook();
    const result = await hook.mutationFn({ ownerId: 'owner-7', signableDocumentId: APT_DOC });

    // Resolve: scoped to the owner + pending only (never widens to all rows).
    expect(listSignatureRequests).toHaveBeenCalledWith({
      ownerId: 'owner-7',
      status: 'pending',
      limit: 1,
    });
    // Resend: targets the RESOLVED request id, NOT the ownerId.
    expect(resendSignatureRequest).toHaveBeenCalledWith('req-99');
    expect(resendSignatureRequest).not.toHaveBeenCalledWith('owner-7');
    // No CREATE when a live pending request already exists.
    expect(createSignatureRequest).not.toHaveBeenCalled();
    // A channel actually carried the link → delivered:true (the path is 'resent').
    expect(result).toEqual({ action: 'resent', delivered: true });
    // Generous timeout: this is the first test to pull the real shared-types
    // `didAnyChannelDeliver` into the graph (cold transform), not a slow test.
  }, 30_000);

  it('2) no pending BUT a per-apartment signable doc + delivered → creates {documentId, ownerId}, returns {created, delivered:true}, never resends', async () => {
    listSignatureRequests.mockResolvedValue({
      items: [],
      page: { limit: 1, cursor: null, has_more: false },
    });
    createSignatureRequest.mockResolvedValue({
      request: PENDING_ROW,
      signUrl: SIGN_URL,
      delivery: DELIVERED_REPORT,
    });

    const hook = await loadHook();
    const result = await hook.mutationFn({ ownerId: 'owner-7', signableDocumentId: APT_DOC });

    // CREATE against THIS holdout's per-apartment signable doc, keyed by the owner
    // (HB-5 fix — the apartment's own agreement, so an associated owner is 201).
    expect(createSignatureRequest).toHaveBeenCalledWith({
      documentId: APT_DOC,
      ownerId: 'owner-7',
    });
    // No resend when there was nothing pending.
    expect(resendSignatureRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'created', delivered: true });
  });

  // ── delivery-outcome honesty (#2): the path taken is NOT proof a channel went ──
  it('2a) CREATE whose delivery reached NO channel → {created, delivered:false} (must NOT be reported as sent)', async () => {
    listSignatureRequests.mockResolvedValue({
      items: [],
      page: { limit: 1, cursor: null, has_more: false },
    });
    // Created the row, but the owner has no email AND no phone → nothing was sent.
    createSignatureRequest.mockResolvedValue({
      request: PENDING_ROW,
      signUrl: SIGN_URL,
      delivery: NO_CHANNEL_REPORT,
    });

    const hook = await loadHook();
    const result = await hook.mutationFn({ ownerId: 'owner-7', signableDocumentId: APT_DOC });

    // The request EXISTS (path 'created') but delivered:false — the toast layer
    // shows "send manually", never "sent".
    expect(result).toEqual({ action: 'created', delivered: false });
  });

  it('2b) RESEND whose every channel was unavailable → {resent, delivered:false} (re-minted but nothing sent)', async () => {
    listSignatureRequests.mockResolvedValue({
      items: [PENDING_ROW],
      page: { limit: 1, cursor: null, has_more: false },
    });
    resendSignatureRequest.mockResolvedValue({
      request: PENDING_ROW,
      signUrl: SIGN_URL,
      delivery: NO_CHANNEL_REPORT,
    });

    const hook = await loadHook();
    const result = await hook.mutationFn({ ownerId: 'owner-7', signableDocumentId: APT_DOC });

    expect(result).toEqual({ action: 'resent', delivered: false });
  });

  it('3) no pending AND no signable doc → typed holdout_none_pending; neither resend nor create', async () => {
    listSignatureRequests.mockResolvedValue({
      items: [],
      page: { limit: 1, cursor: null, has_more: false },
    });

    const hook = await loadHook();
    await expect(
      hook.mutationFn({ ownerId: 'owner-7', signableDocumentId: null }),
    ).rejects.toMatchObject({ code: 'holdout_none_pending' });
    await expect(
      hook.mutationFn({ ownerId: 'owner-7', signableDocumentId: null }),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(resendSignatureRequest).not.toHaveBeenCalled();
    expect(createSignatureRequest).not.toHaveBeenCalled();
  });

  it('4) onSuccess invalidates BOTH the board pulse AND the signature-requests key', async () => {
    const hook = await loadHook();
    hook.onSuccess();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['signature-pulse'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['signature-requests'] });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});
