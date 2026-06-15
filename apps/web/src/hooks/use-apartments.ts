'use client';

import type { Apartment, ApartmentStatus, CreateApartment } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toApartmentViewModel, toApartmentViewModels } from '@/adapters/apartment';
import {
  archiveApartment,
  createApartment,
  getApartment,
  listApartments,
  updateApartmentStatus,
  type ApartmentListPage,
} from '@/lib/api/apartments';
import { useDisplayLocale } from '@/lib/locale';
import type { ApartmentViewModel } from '@/models/apartment.vm';

import { applyApartmentStatus, type ApartmentCache } from './apartment-optimistic';

const APARTMENTS_KEY = ['apartments'] as const;

/** Snapshot of every apartments cache entry (detail + lists), for rollback. */
type ApartmentCacheSnapshot = [readonly unknown[], ApartmentCache | undefined][];

export function useApartmentList(
  buildingId: string | undefined,
  query: { limit?: number; cursor?: string } = {},
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: ApartmentListPage) => ({
      items: toApartmentViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
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
    select,
  });
}

export function useApartment(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback((data: Apartment) => toApartmentViewModel(data, locale), [locale]);
  return useQuery({
    queryKey: [...APARTMENTS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useApartment requires an id');
      return getApartment(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
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

/**
 * Status change with OPTIMISTIC UI: the apartment's status (the badge, the
 * detail header, the row in the building list) flips the instant the manager
 * clicks — no wait for the PATCH + refetch. Patches BOTH cache shapes (detail
 * record + any list page) under ['apartments'], snapshots for rollback on
 * error, reconciles onSettled. cancelQueries first so an in-flight fetch can't
 * clobber the optimistic value (TanStack optimistic-update recipe).
 */
export function useUpdateApartmentStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: ApartmentStatus }) =>
      updateApartmentStatus(id, status),
    onMutate: async ({
      id,
      status,
    }: {
      id: string;
      status: ApartmentStatus;
    }): Promise<{ prev: ApartmentCacheSnapshot }> => {
      await qc.cancelQueries({ queryKey: APARTMENTS_KEY });
      const prev = qc.getQueriesData<ApartmentCache>({ queryKey: APARTMENTS_KEY });
      const at = new Date();
      qc.setQueriesData<ApartmentCache>({ queryKey: APARTMENTS_KEY }, (old) =>
        applyApartmentStatus(old, id, status, at),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: APARTMENTS_KEY });
    },
  });
}
