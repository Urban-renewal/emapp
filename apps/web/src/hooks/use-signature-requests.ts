'use client';

// Value import — the CANONICAL delivery predicate (single source of truth,
// shared with the BE tallies). Reused, never re-implemented, so "delivered vs
// no-channel" cannot drift between the server tally and this client toast.
import { didAnyChannelDeliver } from '@emapp/shared-types';
import type {
  CreateSignatureRequest,
  ListSignatureRequestsQueryDto,
  SignatureCampaignInput,
  SignatureCampaignResponse,
  SignatureRequest,
  SignatureRequestCreateResponse,
  SignatureRequestLinkResponse,
} from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  toSignatureRequestViewModel,
  toSignatureRequestViewModels,
} from '@/adapters/signature-request';
import { ApiClientError } from '@/lib/api/errors';
import {
  cancelSignatureRequest,
  createSignatureCampaign,
  createSignatureRequest,
  getSignatureRequest,
  listSignatureRequests,
  resendSignatureRequest,
  retrieveSignatureLink,
  type SignatureRequestListPage,
} from '@/lib/api/signature-requests';
import { useDisplayLocale } from '@/lib/locale';
import type { SignatureRequestViewModel } from '@/models/signature-request.vm';

import { SIGREQ_KEY, signatureRequestsListQueryKey } from './use-signature-requests.keys';

export { signatureRequestsListQueryKey };

export function useSignatureRequestList(query: Partial<ListSignatureRequestsQueryDto> = {}) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: SignatureRequestListPage) => ({
      items: toSignatureRequestViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    SignatureRequestListPage,
    Error,
    { items: SignatureRequestViewModel[]; page: SignatureRequestListPage['page'] }
  >({
    queryKey: signatureRequestsListQueryKey(query, locale),
    queryFn: () => listSignatureRequests(query),
    staleTime: 30_000,
    select,
  });
}

export function useSignatureRequest(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: SignatureRequest) => toSignatureRequestViewModel(data, locale),
    [locale],
  );
  return useQuery({
    queryKey: [...SIGREQ_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useSignatureRequest requires an id');
      return getSignatureRequest(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

export function useCreateSignatureRequest() {
  const qc = useQueryClient();
  return useMutation<SignatureRequestCreateResponse, Error, CreateSignatureRequest>({
    mutationFn: (body) => createSignatureRequest(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
    },
  });
}

/**
 * Retrieve (re-mint) a PENDING request's signing link for OUT-OF-BAND delivery
 * (P4 phone-less owner). On success the caller copies `signUrl` to the clipboard
 * — it is a BEARER credential, so DON'T persist the result anywhere durable.
 *
 * Re-minting rotates the `jti`/expiry, so we invalidate the request queries (the
 * old link is dead; expiresAt moved). 0 retries (mutation default) — re-firing a
 * mint that may have succeeded would silently invalidate a link the manager just
 * copied.
 */
export function useRetrieveSignatureLink() {
  const qc = useQueryClient();
  return useMutation<SignatureRequestLinkResponse, Error, string>({
    mutationFn: (id: string) => retrieveSignatureLink(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
    },
  });
}

/**
 * S5b — SIGNATURE CAMPAIGN. Fan out ONE project document to ALL active owners of
 * the project. On success we invalidate BOTH the signature-requests queries (new
 * pending rows) AND the projects queries (the signature-progress board / KPI
 * counts read off `['projects']`). 0 retries (mutation default) — re-firing a
 * fan-out that may have succeeded would re-send to owners. Idempotency-Key in the
 * api layer also guards a double-click.
 */
export function useCreateSignatureCampaign(projectId: string) {
  const qc = useQueryClient();
  return useMutation<SignatureCampaignResponse, Error, SignatureCampaignInput>({
    mutationFn: (body) => createSignatureCampaign(projectId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useCancelSignatureRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelSignatureRequest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
    },
  });
}

/** The `error.code` the resolve step throws when an owner has no live PENDING
 *  request to remind AND the project has no campaign document to create one
 *  against (already signed / cancelled / expired AND nothing to (re)collect).
 *  Distinct from a wire failure so the UI can show the calm "nothing-to-remind"
 *  copy rather than the generic retry line. */
export const HOLDOUT_NONE_PENDING_CODE = 'holdout_none_pending';

/** The outcome of a one-click holdout chase — surfaced so the caller's toast is
 *  HONEST on TWO axes:
 *    • `action` — was an EXISTING pending request re-sent (`resent`) or a NEW one
 *      created (`created`)? (drives "reminder sent" vs "signature request sent").
 *    • `delivered` — did a channel ACTUALLY carry the link (`didAnyChannelDeliver`
 *      over the create/resend `delivery` report)? `false` ⇒ the request exists but
 *      reached NO channel (owner has no email AND no phone, or PII decrypt failed)
 *      — nothing was sent, so the toast MUST say "send manually", NEVER "sent".
 *  Splitting these is the delivery-outcome-honesty fix (#2): the path taken is NOT
 *  evidence of delivery. */
export interface HoldoutChaseResult {
  action: 'resent' | 'created';
  delivered: boolean;
}

/** Input to {@link useChaseHoldout}: the holdout owner + the document the create
 *  targets (null when there is no signable doc for this holdout — then a
 *  no-pending owner is a dead-end and we throw `holdout_none_pending`). */
export interface ChaseHoldoutInput {
  ownerId: string;
  /** HB-5 fix — the PER-APARTMENT signable document id (from the B4 holdout row).
   *  Signing is per-apartment, so this is THIS holdout's OWN apartment agreement
   *  (else the project fallback). When the owner has no live pending request and
   *  this is set, we CREATE a request against it; when it is null we have nothing
   *  to collect against. Using the apartment's doc (not a single project-wide
   *  campaign doc) is what makes the create target the holdout's OWN apartment so
   *  an associated owner gets 201 rather than a 409 `recipient_not_associated`. */
  signableDocumentId: string | null;
}

/**
 * HB-5 — one-click STATE-AWARE per-name holdout chase (supersedes the HB-3
 * resend-only path so the board never dead-ends).
 *
 * A holdout row carries only the `ownerId` (the B4 surface returns NAME +
 * ownerId, never a signature-request id). The chase is state-aware:
 *   1. RESOLVE the owner's live pending request — `GET /signature-requests?
 *      ownerId=&status=pending`. If one exists → RESEND it (`POST
 *      /signature-requests/:id/resend`; idempotent re-mint + re-deliver) →
 *      action 'resent'.
 *   2. ELSE, if the project has a campaign document → CREATE a fresh request
 *      against it (`POST /signature-requests { documentId, ownerId }`, the
 *      EXISTING gated create — association + visibility + PII delivery enforced
 *      server-side) → action 'created'. The Idempotency-Key in the api layer
 *      guards a double-tap.
 *   3. ELSE (no pending AND no campaign doc) → throw the typed
 *      `holdout_none_pending` so the caller shows the calm copy (NOT an error).
 *      In practice the board hides the per-name remind entirely when the project
 *      has no campaign (it offers "start collection" instead), so this is the
 *      belt-and-suspenders path for a stale board.
 *
 * On success we invalidate `['signature-pulse']` (the board re-derives its
 * attention/stalled signals) AND the signature-requests queries. 0 retries
 * (mutation default). Gating to actors holding `signature_requests.send` is the
 * CALLER's job (the button is hidden for a Viewer); the BE enforces it too.
 */
export function useChaseHoldout() {
  const qc = useQueryClient();
  return useMutation<HoldoutChaseResult, Error, ChaseHoldoutInput>({
    mutationFn: async ({ ownerId, signableDocumentId }): Promise<HoldoutChaseResult> => {
      // Resolve the owner's single live pending request. `status: 'pending'`
      // already excludes signed/cancelled/expired rows; we take the first
      // (an owner has at most one live pending request per project document,
      // and the board card is a single project's holdout).
      const pending = await listSignatureRequests({ ownerId, status: 'pending', limit: 1 });
      const target = pending.items[0];
      if (target) {
        // resend returns the FULL `{ request, signUrl, delivery }`. Honesty axis:
        // a re-mint that reached NO channel (no email+phone / PII decrypt failed)
        // is NOT a send — derive it from the CANONICAL predicate, never the path.
        const res = await resendSignatureRequest(target.id);
        return { action: 'resent', delivered: didAnyChannelDeliver(res.delivery) };
      }
      // No live pending request — CREATE one against THIS holdout's per-apartment
      // signable doc (the BE enforces association/visibility/PII delivery +
      // idempotency). Using the apartment's own agreement is what makes an
      // associated owner 201 rather than 409 `recipient_not_associated`.
      if (signableDocumentId) {
        const res = await createSignatureRequest({ documentId: signableDocumentId, ownerId });
        return { action: 'created', delivered: didAnyChannelDeliver(res.delivery) };
      }
      // Nothing to (re)chase and no campaign to create against — calm dead-end.
      throw new ApiClientError({ code: HOLDOUT_NONE_PENDING_CODE });
    },
    onSuccess: () => {
      // The board reads the pulse query; refresh it so the holdout's chase
      // state reflects the (re)delivered request. Also refresh the SR queries.
      qc.invalidateQueries({ queryKey: ['signature-pulse'] });
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
    },
  });
}
