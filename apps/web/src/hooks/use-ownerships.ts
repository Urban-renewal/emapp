'use client';

import type { SetOwnerships } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toOwnershipViewModels } from '@/adapters/ownership';
import { listApartmentOwners, putOwnerships, type ApartmentOwnersPage } from '@/lib/api/ownerships';
import { stripBidiOverrides } from '@/lib/bidi';
import type { OwnershipViewModel } from '@/models/ownership.vm';

const OWNERSHIPS_KEY = ['ownerships'] as const;

/**
 * S3d — a co-owner's display name + the EXACT Tabu share rendered as a fraction
 * (e.g. "1/3"). Kept SEPARATE from `OwnershipViewModel` (whose key-set is pinned
 * by `ownership.spec.ts`): this is a read-only display projection for the
 * co-owners list, carrying only the share + name (masked-PII-free; no clear
 * national_id/phone). When the wire omits the fraction (pre-S3d fixture), the
 * label falls back to the compat percent so the row is never blank.
 */
export interface CoOwnerShareViewModel {
  ownerId: string;
  displayName: string;
  /** e.g. "1/3" (exact fraction) or "33.33%" (compat-percent fallback). */
  shareLabel: string;
}

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

/**
 * S3d — the apartment's co-owners with their EXACT share rendered as a fraction.
 * Shares the SAME query key (and therefore the same single fetch) as
 * `useApartmentOwners`; only the `select` differs, so there is no extra request.
 * Read-only display shape — no PII beyond the masked name the wire already ships.
 */
export function useApartmentCoOwnerShares(apartmentId: string | undefined) {
  const select = useCallback(
    (data: ApartmentOwnersPage): CoOwnerShareViewModel[] =>
      data.items.map((o) => ({
        ownerId: o.id,
        // Shell owner — no name yet; show a neutral placeholder (mirrors the
        // ownership adapter). Bidi-stripped (§SEC-M4).
        displayName: o.name ? stripBidiOverrides(o.name) : 'ללא שם',
        shareLabel:
          o.shareNumerator !== undefined && o.shareDenominator !== undefined
            ? `${o.shareNumerator}/${o.shareDenominator}`
            : `${o.ownershipPct}%`,
      })),
    [],
  );
  return useQuery<ApartmentOwnersPage, Error, CoOwnerShareViewModel[]>({
    queryKey: [...OWNERSHIPS_KEY, 'apt-owners', apartmentId],
    queryFn: () => {
      if (!apartmentId) throw new Error('useApartmentCoOwnerShares requires apartmentId');
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
