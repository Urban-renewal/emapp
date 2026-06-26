'use client';

import type { ApartmentStateView, CreateApartmentState } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createApartmentState,
  listApartmentStates,
  resolveApartmentState,
} from '@/lib/api/apartment-states';

/** Query key for an apartment's active legal/life states. Locale-independent — the
 *  kind labels are translated in the component, not the cache. */
export function apartmentStatesQueryKey(apartmentId: string) {
  return ['apartments', 'states', apartmentId] as const;
}

/** The ACTIVE legal/life states on an apartment. */
export function useApartmentStates(apartmentId: string | undefined, enabled = true) {
  return useQuery<ApartmentStateView[]>({
    queryKey: apartmentStatesQueryKey(apartmentId ?? ''),
    queryFn: () => listApartmentStates(apartmentId as string),
    enabled: Boolean(apartmentId) && enabled,
    staleTime: 30_000,
  });
}

/** Create a legal/life state on an apartment, then refresh its states + the org
 *  situation-picture counts. */
export function useCreateApartmentState(apartmentId: string) {
  const qc = useQueryClient();
  return useMutation<ApartmentStateView, Error, CreateApartmentState>({
    mutationFn: (body) => createApartmentState(apartmentId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: apartmentStatesQueryKey(apartmentId) });
      void qc.invalidateQueries({ queryKey: ['org', 'stats'] });
    },
  });
}

/** Resolve a legal/life state (status transition). Refreshes the apartment's states. */
export function useResolveApartmentState(apartmentId: string) {
  const qc = useQueryClient();
  return useMutation<ApartmentStateView, Error, string>({
    mutationFn: (stateId) => resolveApartmentState(stateId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: apartmentStatesQueryKey(apartmentId) });
      void qc.invalidateQueries({ queryKey: ['org', 'stats'] });
    },
  });
}
