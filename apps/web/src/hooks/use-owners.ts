'use client';

import type { CreateOwner } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { toOwnerViewModel, toOwnerViewModels } from '@/adapters/owner';
import {
  archiveOwner,
  createOwner,
  getOwner,
  listOwners,
  type OwnerListPage,
} from '@/lib/api/owners';
import type { OwnerViewModel } from '@/models/owner.vm';

const OWNERS_KEY = ['owners'] as const;

export function useOwnerList(query: { limit?: number; cursor?: string } = {}) {
  return useQuery<OwnerListPage, Error, { items: OwnerViewModel[]; page: OwnerListPage['page'] }>({
    queryKey: [...OWNERS_KEY, 'list', query],
    queryFn: () => listOwners(query),
    staleTime: 30_000,
    select: (data) => ({ items: toOwnerViewModels(data.items), page: data.page }),
  });
}

export function useOwner(id: string | undefined) {
  return useQuery({
    queryKey: [...OWNERS_KEY, 'one', id],
    queryFn: () => {
      if (!id) throw new Error('useOwner requires an id');
      return getOwner(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select: toOwnerViewModel,
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
