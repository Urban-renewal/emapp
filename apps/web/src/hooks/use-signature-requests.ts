'use client';

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
 *  request to remind (already signed / cancelled / expired since the board last
 *  loaded). Distinct from a wire failure so the UI can show the calm
 *  "nothing-to-remind" copy rather than the generic retry line. */
export const HOLDOUT_NONE_PENDING_CODE = 'holdout_none_pending';

/**
 * HB-3 — PER-NAME single remind for a board-card holdout.
 *
 * A holdout row carries only the `ownerId` (the B4 surface returns NAME +
 * ownerId, never a signature-request id). The org-side resend endpoint is keyed
 * by the REQUEST id, so this mutation does a two-step:
 *   1. RESOLVE the owner's live pending request — `GET /signature-requests?
 *      ownerId=&status=pending` (the BE already supports both filters). If there
 *      is none the owner has nothing to re-chase → throw a typed
 *      `holdout_none_pending` so the caller shows the calm copy (NOT an error).
 *   2. RESEND it — `POST /signature-requests/:id/resend` (idempotent; re-mints +
 *      re-delivers ONE link).
 *
 * On success we invalidate `['signature-pulse']` (the board re-derives its
 * attention/stalled signals) AND the signature-requests queries (the resent
 * row's expiry moved). 0 retries (mutation default) — re-firing a resend that
 * may have landed would re-deliver; the Idempotency-Key in the api layer also
 * guards the double-tap. Gating to actors holding `signature_requests.send` is
 * the CALLER's job (the button is hidden for a Viewer); the BE enforces it too.
 */
export function useResendHoldoutReminder() {
  const qc = useQueryClient();
  return useMutation<SignatureRequest, Error, string>({
    mutationFn: async (ownerId: string): Promise<SignatureRequest> => {
      // Resolve the owner's single live pending request. `status: 'pending'`
      // already excludes signed/cancelled/expired rows; we take the first
      // (an owner has at most one live pending request per project document,
      // and the board card is a single project's holdout).
      const pending = await listSignatureRequests({ ownerId, status: 'pending', limit: 1 });
      const target = pending.items[0];
      if (!target) {
        throw new ApiClientError({ code: HOLDOUT_NONE_PENDING_CODE });
      }
      return resendSignatureRequest(target.id);
    },
    onSuccess: () => {
      // The board reads the pulse query; refresh it so the holdout's chase
      // state reflects the re-delivered reminder. Also refresh the SR queries.
      qc.invalidateQueries({ queryKey: ['signature-pulse'] });
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
    },
  });
}
