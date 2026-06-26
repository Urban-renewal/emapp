'use client';

import type { CreateOwnerState, OwnerStateView } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createOwnerState, listOwnerStates, resolveOwnerState } from '@/lib/api/owner-states';

import { OWNERS_KEY } from './use-owners.keys';

/** Query key for an owner's active legal/life states. Locale-independent — the
 *  kind/guardian labels are translated in the component, not the cache. */
export function ownerStatesQueryKey(ownerId: string) {
  return [...OWNERS_KEY, 'states', ownerId] as const;
}

/** The ACTIVE legal/life states on an owner (masked guardian). */
export function useOwnerStates(ownerId: string | undefined, enabled = true) {
  return useQuery<OwnerStateView[]>({
    queryKey: ownerStatesQueryKey(ownerId ?? ''),
    queryFn: () => listOwnerStates(ownerId as string),
    enabled: Boolean(ownerId) && enabled,
    staleTime: 30_000,
  });
}

/** Create a legal/life state on an owner, then refresh its states + the owner
 *  caches (the situation-picture counts come from /org/stats, refreshed on its
 *  own staleness). */
export function useCreateOwnerState(ownerId: string) {
  const qc = useQueryClient();
  return useMutation<OwnerStateView, Error, CreateOwnerState>({
    mutationFn: (body) => createOwnerState(ownerId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ownerStatesQueryKey(ownerId) });
      void qc.invalidateQueries({ queryKey: ['org', 'stats'] });
    },
  });
}

/** Resolve a legal/life state (status transition). Refreshes the owner's states. */
export function useResolveOwnerState(ownerId: string) {
  const qc = useQueryClient();
  return useMutation<OwnerStateView, Error, string>({
    mutationFn: (stateId) => resolveOwnerState(stateId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ownerStatesQueryKey(ownerId) });
      void qc.invalidateQueries({ queryKey: ['org', 'stats'] });
    },
  });
}
