'use client';

import type { SetOwnerships } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { toOwnershipViewModels } from '@/adapters/ownership';
import { listApartmentOwners, putOwnerships, type ApartmentOwnersPage } from '@/lib/api/ownerships';
import type { OwnershipViewModel } from '@/models/ownership.vm';

const OWNERSHIPS_KEY = ['ownerships'] as const;

export function useApartmentOwners(apartmentId: string | undefined) {
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
    // §SOLID-H1 closure — components consume VMs, not raw wire.
    select: (data) => ({ items: toOwnershipViewModels(data.items), page: data.page }),
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
