'use client';

import type { Building, CreateBuilding } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toBuildingViewModel, toBuildingViewModels } from '@/adapters/building';
import {
  archiveBuilding,
  createBuilding,
  getBuilding,
  listBuildings,
  type BuildingListPage,
} from '@/lib/api/buildings';
import { useDisplayLocale } from '@/lib/locale';
import type { BuildingViewModel } from '@/models/building.vm';

const BUILDINGS_KEY = ['buildings'] as const;

export function useBuildingList(
  projectId: string | undefined,
  query: { limit?: number; cursor?: string } = {},
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: BuildingListPage) => ({
      items: toBuildingViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    BuildingListPage,
    Error,
    { items: BuildingViewModel[]; page: BuildingListPage['page'] }
  >({
    queryKey: [...BUILDINGS_KEY, 'list', projectId, query, locale],
    queryFn: () => {
      if (!projectId) throw new Error('useBuildingList requires projectId');
      return listBuildings(projectId, query);
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
    select,
  });
}

export function useBuilding(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback((data: Building) => toBuildingViewModel(data, locale), [locale]);
  return useQuery({
    queryKey: [...BUILDINGS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useBuilding requires an id');
      return getBuilding(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

export function useCreateBuilding(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBuilding) => createBuilding(projectId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BUILDINGS_KEY });
    },
  });
}

export function useArchiveBuilding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveBuilding(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BUILDINGS_KEY });
    },
  });
}
