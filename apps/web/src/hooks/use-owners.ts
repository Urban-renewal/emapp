'use client';

import type { CreateOwner, Owner } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toOwnerViewModel, toOwnerViewModels } from '@/adapters/owner';
import {
  archiveOwner,
  createOwner,
  getOwner,
  listOwners,
  type OwnerListPage,
} from '@/lib/api/owners';
import { useDisplayLocale } from '@/lib/locale';
import type { OwnerViewModel } from '@/models/owner.vm';

const OWNERS_KEY = ['owners'] as const;

export function useOwnerList(query: { limit?: number; cursor?: string } = {}) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: OwnerListPage) => ({
      items: toOwnerViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<OwnerListPage, Error, { items: OwnerViewModel[]; page: OwnerListPage['page'] }>({
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
