'use client';

import type {
  CreateSignatureRequest,
  ListSignatureRequestsQueryDto,
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
import {
  cancelSignatureRequest,
  createSignatureRequest,
  getSignatureRequest,
  listSignatureRequests,
  retrieveSignatureLink,
  type SignatureRequestListPage,
} from '@/lib/api/signature-requests';
import { useDisplayLocale } from '@/lib/locale';
import type { SignatureRequestViewModel } from '@/models/signature-request.vm';

const SIGREQ_KEY = ['signature-requests'] as const;

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
    queryKey: [...SIGREQ_KEY, 'list', query, locale],
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

export function useCancelSignatureRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelSignatureRequest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
    },
  });
}
