'use client';

import type { CreateApartment } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import { toApartmentViewModel, toApartmentViewModels } from '@/adapters/apartment';
import {
  archiveApartment,
  createApartment,
  getApartment,
  listApartments,
  type ApartmentListPage,
} from '@/lib/api/apartments';
import type { ApartmentViewModel } from '@/models/apartment.vm';

const APARTMENTS_KEY = ['apartments'] as const;
function he_or_en(loc: string): 'he' | 'en' {
  return loc === 'en' ? 'en' : 'he';
}

export function useApartmentList(
  buildingId: string | undefined,
  query: { limit?: number; cursor?: string } = {},
) {
  const locale = he_or_en(useLocale());
  return useQuery<
    ApartmentListPage,
    Error,
    { items: ApartmentViewModel[]; page: ApartmentListPage['page'] }
  >({
    queryKey: [...APARTMENTS_KEY, 'list', buildingId, query, locale],
    queryFn: () => {
      if (!buildingId) throw new Error('useApartmentList requires buildingId');
      return listApartments(buildingId, query);
    },
    enabled: Boolean(buildingId),
    staleTime: 30_000,
    select: (data) => ({ items: toApartmentViewModels(data.items, locale), page: data.page }),
  });
}

export function useApartment(id: string | undefined) {
  const locale = he_or_en(useLocale());
  return useQuery({
    queryKey: [...APARTMENTS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useApartment requires an id');
      return getApartment(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select: (data) => toApartmentViewModel(data, locale),
  });
}

export function useCreateApartment(buildingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateApartment) => createApartment(buildingId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: APARTMENTS_KEY });
    },
  });
}

export function useArchiveApartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveApartment(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: APARTMENTS_KEY });
    },
  });
}
