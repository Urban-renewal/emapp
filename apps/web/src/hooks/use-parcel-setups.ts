'use client';

import type { CreateParcelSetup, ParcelSetupPayloadDto } from '@emapp/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  confirmParcelSetup,
  createParcelSetup,
  updateParcelSetupPayload,
} from '@/lib/api/parcel-setups';

/**
 * P3c — TanStack mutation wrappers for the parcel-setup lifecycle
 * (create draft → save payload → confirm). All three are user-initiated
 * mutations; there is no query here — the draft lives in component state
 * until the confirm materializes it.
 *
 * On confirm success the BUILDINGS query family is invalidated: the confirm
 * just created physical buildings + apartments, so any mounted buildings
 * list must refetch (and the P3c success panel mounts one — see
 * parcel-setup-section.tsx).
 */
const BUILDINGS_KEY = ['buildings'] as const;

export function useCreateParcelSetup(projectId: string) {
  return useMutation({
    mutationFn: (body: CreateParcelSetup) => createParcelSetup(projectId, body),
  });
}

export function useSaveParcelSetupPayload() {
  return useMutation({
    mutationFn: (args: { id: string; payload: ParcelSetupPayloadDto }) =>
      updateParcelSetupPayload(args.id, args.payload),
  });
}

export function useConfirmParcelSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => confirmParcelSetup(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BUILDINGS_KEY });
    },
  });
}
