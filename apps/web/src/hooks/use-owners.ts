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
  type OwnerListPage,
} from '@/lib/api/owners';
import { useDisplayLocale } from '@/lib/locale';
import type { OwnerProjectViewModel } from '@/models/owner-project.vm';
import type { OwnerListItemViewModel } from '@/models/owner.vm';

const OWNERS_KEY = ['owners'] as const;

export function useOwnerList(query: { limit?: number; cursor?: string } = {}) {
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
    queryKey: [...OWNERS_KEY, 'list', query, locale],
    queryFn: () => listOwners(query),
    staleTime: 30_000,
    select,
  });
}

export function useOwner(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback((data: Owner) => toOwnerViewModel(data, locale), [locale]);
  return useQuery({
    queryKey: [...OWNERS_KEY, 'one', id, locale],
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
    queryKey: [...OWNERS_KEY, 'projects', id],
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
