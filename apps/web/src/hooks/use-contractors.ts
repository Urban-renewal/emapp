'use client';

import type { CreateContractor, UpdateContractor } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toContractorViewModel, toContractorViewModels } from '@/adapters/contractor';
import {
  archiveContractor,
  createContractor,
  getContractor,
  listContractors,
  updateContractor,
  type ContractorListPage,
} from '@/lib/api/contractors';
import { useDisplayLocale } from '@/lib/locale';
import type { ContractorViewModel } from '@/models/contractor.vm';

import { CONTRACTORS_KEY, contractorsListQueryKey } from './use-contractors.keys';

export { contractorsListQueryKey };

export function useContractorList(
  query: { limit?: number; cursor?: string; q?: string; specialty?: string } = {},
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: ContractorListPage) => ({
      items: toContractorViewModels(data.items, locale),
      facets: data.facets,
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    ContractorListPage,
    Error,
    {
      items: ContractorViewModel[];
      facets: ContractorListPage['facets'];
      page: ContractorListPage['page'];
    }
  >({
    queryKey: contractorsListQueryKey(query, locale),
    queryFn: () => listContractors(query),
    staleTime: 30_000,
    select,
  });
}

export function useContractor(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: import('@emapp/shared-types').Contractor) => toContractorViewModel(data, locale),
    [locale],
  );
  return useQuery({
    queryKey: [...CONTRACTORS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useContractor requires an id');
      return getContractor(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

export function useCreateContractor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateContractor) => createContractor(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONTRACTORS_KEY }),
  });
}

export function useUpdateContractor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: UpdateContractor }) =>
      updateContractor(input.id, input.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONTRACTORS_KEY }),
  });
}

export function useArchiveContractor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveContractor(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONTRACTORS_KEY }),
  });
}
