'use client';

import type {
  CreateSignatureRequest,
  ListSignatureRequestsQueryDto,
  SignatureRequestCreateResponse,
} from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

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
import type { SignatureRequestViewModel } from '@/models/signature-request.vm';

const SIGREQ_KEY = ['signature-requests'] as const;

function he_or_en(loc: string): 'he' | 'en' {
  return loc === 'en' ? 'en' : 'he';
}

export function useSignatureRequestList(query: Partial<ListSignatureRequestsQueryDto> = {}) {
  const locale = he_or_en(useLocale());
  return useQuery<
    SignatureRequestListPage,
    Error,
    { items: SignatureRequestViewModel[]; page: SignatureRequestListPage['page'] }
  >({
    queryKey: [...SIGREQ_KEY, 'list', query, locale],
    queryFn: () => listSignatureRequests(query),
    staleTime: 30_000,
    select: (data) => ({
      items: toSignatureRequestViewModels(data.items, locale),
      page: data.page,
    }),
  });
}

export function useSignatureRequest(id: string | undefined) {
  const locale = he_or_en(useLocale());
  return useQuery({
    queryKey: [...SIGREQ_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useSignatureRequest requires an id');
      return getSignatureRequest(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select: (data) => toSignatureRequestViewModel(data, locale),
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
