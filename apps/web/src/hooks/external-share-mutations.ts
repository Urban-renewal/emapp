'use client';

/**
 * External-share mutation hooks — V13 X-S6/X-S7. Create / extend / resend /
 * revoke, each invalidating the canonical list key on success (the canonical
 * mutation→invalidate flow from `use-shares.ts` / `notifications-optimistic.ts`
 * — NEVER a second hand-rolled refetch). Mutations carry 0 retries (repo
 * convention) so a 403 ceiling-rejection surfaces immediately to the caller.
 */
import type { CreateExternalShare, ExtendExternalShare } from '@emapp/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  createExternalShare,
  extendExternalShare,
  resendExternalShare,
  revokeExternalShare,
} from '@/lib/api/external-shares';

import { EXTERNAL_SHARES_KEY } from './external-share-list';

export function useCreateExternalShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateExternalShare) => createExternalShare(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...EXTERNAL_SHARES_KEY, 'list'] }),
  });
}

export function useExtendExternalShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: ExtendExternalShare }) =>
      extendExternalShare(input.id, input.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...EXTERNAL_SHARES_KEY, 'list'] }),
  });
}

export function useResendExternalShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => resendExternalShare(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...EXTERNAL_SHARES_KEY, 'list'] }),
  });
}

export function useRevokeExternalShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeExternalShare(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...EXTERNAL_SHARES_KEY, 'list'] }),
  });
}
