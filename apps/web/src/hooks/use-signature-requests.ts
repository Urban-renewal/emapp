'use client';

import type {
  CreateSignatureRequest,
  ListSignatureRequestsQueryDto,
  SignatureRequest,
  SignatureRequestCreateResponse,
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

export function useCancelSignatureRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelSignatureRequest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
    },
  });
}
