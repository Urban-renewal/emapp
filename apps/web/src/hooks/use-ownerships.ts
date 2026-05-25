'use client';

import type { SetOwnerships } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toOwnershipViewModels } from '@/adapters/ownership';
import { listApartmentOwners, putOwnerships, type ApartmentOwnersPage } from '@/lib/api/ownerships';
import type { OwnershipViewModel } from '@/models/ownership.vm';

const OWNERSHIPS_KEY = ['ownerships'] as const;

export function useApartmentOwners(apartmentId: string | undefined) {
  // §SOLID-H1 + §PERF-H3 — memoise select so TanStack structuralSharing
  // can dedupe; no inline arrow with fresh wrapper-object identity.
  const select = useCallback(
    (data: ApartmentOwnersPage) => ({
      items: toOwnershipViewModels(data.items),
      page: data.page,
    }),
    [],
  );
  return useQuery<
    ApartmentOwnersPage,
    Error,
    { items: OwnershipViewModel[]; page: ApartmentOwnersPage['page'] }
  >({
    queryKey: [...OWNERSHIPS_KEY, 'apt-owners', apartmentId],
    queryFn: () => {
      if (!apartmentId) throw new Error('useApartmentOwners requires apartmentId');
      return listApartmentOwners(apartmentId, { limit: 50 });
    },
    enabled: Boolean(apartmentId),
    staleTime: 30_000,
    select,
  });
}

export function useSetOwnerships(apartmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetOwnerships) => putOwnerships(apartmentId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OWNERSHIPS_KEY });
    },
  });
}
