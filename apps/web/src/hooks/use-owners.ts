'use client';

import type { CreateOwner, Owner, OwnerPiiReveal, OwnerProjectSummary } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toOwnerListItemViewModels, toOwnerViewModel } from '@/adapters/owner';
import { toOwnerProjectViewModels } from '@/adapters/owner-project';
import {
  archiveOwner,
  createOwner,
  getOwner,
  getOwnerProjects,
  listOwners,
  revealOwnerPii,
  searchOwnersByName,
  type OwnerListPage,
} from '@/lib/api/owners';
import { useDisplayLocale } from '@/lib/locale';
import type { OwnerProjectViewModel } from '@/models/owner-project.vm';
import type { OwnerListItemViewModel } from '@/models/owner.vm';

import {
  OWNERS_KEY,
  ownerProjectsQueryKey,
  ownerQueryKey,
  ownersListQueryKey,
  ownersSearchQueryKey,
} from './use-owners.keys';

export { ownerProjectsQueryKey, ownerQueryKey, ownersListQueryKey, ownersSearchQueryKey };

export function useOwnerList(
  query: { limit?: number; cursor?: string; archived?: boolean; needsAttention?: boolean } = {},
  enabled = true,
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: OwnerListPage) => ({
      items: toOwnerListItemViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    OwnerListPage,
    Error,
    { items: OwnerListItemViewModel[]; page: OwnerListPage['page'] }
  >({
    queryKey: ownersListQueryKey(query, locale),
    queryFn: () => listOwners(query),
    // B1 — gated off while a name search is active so exactly ONE query
    // (list OR search) fetches at a time; defaults to on (unchanged behaviour).
    enabled,
    staleTime: 30_000,
    select,
  });
}

/**
 * B1 — server-side owner NAME search (`GET /owners/search`). Mirrors
 * {@link useOwnerList} exactly — same `OwnerListPage` shape, same
 * `toOwnerListItemViewModels` select, same keyset cursor — so the owners list
 * can SWAP its data source to this when the search box has a term and the
 * "next page" button keeps working unchanged.
 *
 * `enabled` gates on a non-empty trimmed `q`: with an empty box the list page
 * uses `useOwnerList` instead, so this query simply never runs (and never fires
 * a `GET /owners/search?q=`). The masked-PII discipline is identical to the
 * list (national_id/phone arrive masked from the BE).
 */
export function useOwnerSearch(
  query: { q: string; limit?: number; cursor?: string; needsAttention?: boolean },
  enabled = true,
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: OwnerListPage) => ({
      items: toOwnerListItemViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  const q = query.q.trim();
  return useQuery<
    OwnerListPage,
    Error,
    { items: OwnerListItemViewModel[]; page: OwnerListPage['page'] }
  >({
    queryKey: ownersSearchQueryKey(query, locale),
    queryFn: () => searchOwnersByName(query),
    enabled: enabled && q.length > 0,
    staleTime: 30_000,
    select,
  });
}

export function useOwner(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback((data: Owner) => toOwnerViewModel(data, locale), [locale]);
  return useQuery({
    // See `useProject` — `id` may be undefined before the `enabled` gate; '' is
    // a placeholder for the key shape only (the query is disabled meanwhile).
    queryKey: ownerQueryKey(id ?? '', locale),
    queryFn: () => {
      if (!id) throw new Error('useOwner requires an id');
      return getOwner(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

/**
 * S3d — the DISTINCT projects an owner is tied to via active ownerships.
 * Returns ViewModels (type/status labelled). The BE org/agent-scopes the list,
 * so this never surfaces a project the caller can't see. No owner PII on the
 * wire — it's a project list.
 */
export function useOwnerProjects(id: string | undefined) {
  const select = useCallback(
    (data: OwnerProjectSummary[]): OwnerProjectViewModel[] => toOwnerProjectViewModels(data),
    [],
  );
  return useQuery<OwnerProjectSummary[], Error, OwnerProjectViewModel[]>({
    // No locale segment — the adapter is locale-independent (see the builder).
    queryKey: ownerProjectsQueryKey(id ?? ''),
    queryFn: () => {
      if (!id) throw new Error('useOwnerProjects requires an id');
      return getOwnerProjects(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

export function useCreateOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateOwner) => createOwner(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OWNERS_KEY });
    },
  });
}

export function useArchiveOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveOwner(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OWNERS_KEY });
    },
  });
}

/**
 * D.54 — reveal-on-demand cleartext PII for ONE owner.
 *
 * SECURITY-CRITICAL: the cleartext result is returned from `mutateAsync`
 * for the caller to hold in EPHEMERAL component state ONLY. This hook
 * deliberately has NO `onSuccess` cache write — the cleartext must never
 * enter the TanStack cache (which `useOwner`/list reads from and which is
 * inspectable). It is not cached, not persisted, not logged.
 */
export function useRevealOwnerPii() {
  return useMutation<OwnerPiiReveal, Error, string>({
    mutationFn: (id: string) => revealOwnerPii(id),
  });
}
