'use client';

import type { CreateShare, UpdateShare } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toShareViewModels } from '@/adapters/share';
import {
  createProjectShare,
  listProjectShares,
  mintShareLink,
  revokeShare,
  updateShare,
  type ShareListPage,
} from '@/lib/api/shares';
import { useDisplayLocale } from '@/lib/locale';
import type { ShareViewModel } from '@/models/share.vm';

const SHARES_KEY = ['shares'] as const;

export function useProjectShareList(
  projectId: string | undefined,
  query: { limit?: number; cursor?: string } = {},
  contractorIdToName?: Map<string, string>,
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: ShareListPage) => ({
      items: toShareViewModels(data.items, locale, contractorIdToName),
      page: data.page,
    }),
    [locale, contractorIdToName],
  );
  return useQuery<ShareListPage, Error, { items: ShareViewModel[]; page: ShareListPage['page'] }>({
    queryKey: [...SHARES_KEY, 'list', projectId, query, locale],
    queryFn: () => {
      if (!projectId) throw new Error('useProjectShareList requires a projectId');
      return listProjectShares(projectId, query);
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
    select,
  });
}

export function useCreateProjectShare(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateShare) => {
      if (!projectId) throw new Error('useCreateProjectShare requires a projectId');
      return createProjectShare(projectId, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...SHARES_KEY, 'list', projectId] }),
  });
}

export function useUpdateShare(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: UpdateShare }) => updateShare(input.id, input.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...SHARES_KEY, 'list', projectId] }),
  });
}

export function useRevokeShare(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeShare(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...SHARES_KEY, 'list', projectId] }),
  });
}

/** D2-DEF-1 — mint a share-access link for a share. The returned token is
 *  the contractor credential; the page shows it once for the manager to
 *  copy + send out-of-band. Not cached (it is a credential). */
export function useMintShareLink() {
  return useMutation({ mutationFn: (id: string) => mintShareLink(id) });
}
