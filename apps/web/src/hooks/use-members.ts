'use client';

import type { CreateMember, UpdateMember } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toMemberViewModel, toMemberViewModels } from '@/adapters/member';
import {
  createMember,
  listMembers,
  revokeMember,
  updateMemberRole,
  type CreateMemberResult,
  type MemberListPage,
} from '@/lib/api/members';
import { useDisplayLocale } from '@/lib/locale';
import type { MemberViewModel } from '@/models/member.vm';

/**
 * Members data hooks — TanStack Query. Same shape as `use-projects.ts`:
 *   - `select` callbacks memoised via `useCallback` (PERF-H3 closure)
 *   - 30s staleTime; refetchOnWindowFocus default
 *
 * D.27 invite-token note: `useCreateMember` returns the raw API
 * shape (`{ member, inviteToken? }`) from `mutateAsync`. We do NOT
 * write the token into TanStack cache — the caller renders it once
 * from the mutation result and then it's gone. `onSuccess` invalidates
 * only the list query so the new pending row appears.
 */

const MEMBERS_KEY = ['members'] as const;

export function useMemberList(query: { limit?: number; cursor?: string } = {}) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: MemberListPage) => ({
      items: toMemberViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    MemberListPage,
    Error,
    { items: MemberViewModel[]; page: MemberListPage['page'] }
  >({
    queryKey: [...MEMBERS_KEY, 'list', query, locale],
    queryFn: () => listMembers(query),
    staleTime: 30_000,
    select,
  });
}

/** Find a single member in the list cache (the BE has no GET :id; the
 *  list response carries every field we need). Returns undefined while
 *  the list query is pending or if the userId isn't in the page. */
export function useMember(
  userId: string | undefined,
  query: { limit?: number; cursor?: string } = {},
): { data: MemberViewModel | undefined; isLoading: boolean; isError: boolean } {
  const locale = useDisplayLocale();
  const list = useMemberList(query);
  const found = list.data?.items.find((m) => m.userId === userId);
  // The list `select` already produced VMs; we use the raw items here
  // only as a typed entry point. The VM is found inside the page.
  void toMemberViewModel; // retained as a single VM helper for future detail-fetch
  void locale;
  return {
    data: found,
    isLoading: list.isLoading,
    isError: list.isError,
  };
}

export function useCreateMember() {
  const qc = useQueryClient();
  return useMutation<CreateMemberResult, Error, CreateMember>({
    mutationFn: (body: CreateMember) => createMember(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MEMBERS_KEY });
    },
  });
}

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; body: UpdateMember }) =>
      updateMemberRole(input.userId, input.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MEMBERS_KEY });
    },
  });
}

export function useRevokeMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => revokeMember(userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MEMBERS_KEY });
    },
  });
}
