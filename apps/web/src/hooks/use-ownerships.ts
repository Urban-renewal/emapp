'use client';

import type { SetOwnerships } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listApartmentOwners, putOwnerships, type ApartmentOwnersPage } from '@/lib/api/ownerships';

const OWNERSHIPS_KEY = ['ownerships'] as const;

export function useApartmentOwners(apartmentId: string | undefined) {
  return useQuery<ApartmentOwnersPage, Error>({
    queryKey: [...OWNERSHIPS_KEY, 'apt-owners', apartmentId],
    queryFn: () => {
      if (!apartmentId) throw new Error('useApartmentOwners requires apartmentId');
      return listApartmentOwners(apartmentId, { limit: 50 });
    },
    enabled: Boolean(apartmentId),
    staleTime: 30_000,
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
