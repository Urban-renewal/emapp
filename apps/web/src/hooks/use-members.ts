'use client';

import type {
  ApplyCapabilityPreset,
  ClearMemberOverride,
  CreateMember,
  SetMemberOverride,
  UpdateAgentCapabilities,
  UpdateMember,
} from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toMemberViewModel, toMemberViewModels } from '@/adapters/member';
import {
  applyCapabilityPreset,
  clearMemberOverride,
  createMember,
  listCapabilityPresets,
  listMemberOverrides,
  listMembers,
  resendInvite,
  revokeMember,
  setMemberOverride,
  updateMemberCapabilities,
  updateMemberRole,
  type CreateMemberResult,
  type MemberListPage,
  type ResendInviteResult,
} from '@/lib/api/members';
import { useDisplayLocale } from '@/lib/locale';
import type { MemberViewModel } from '@/models/member.vm';

import { MEMBERS_KEY, membersListQueryKey } from './use-members.keys';

export { membersListQueryKey };

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
    queryKey: membersListQueryKey(query, locale),
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

/**
 * POST /members/:userId/resend — re-issue a pending member's invite.
 * `mutateAsync` returns the raw `{ inviteToken? }` shape; like
 * `useCreateMember` we do NOT write the token into TanStack cache (it's
 * ephemeral, rendered once by the caller). 0 retries (mutation default)
 * so a click never replays the send. We invalidate the list so any
 * server-side state refreshes.
 */
export function useResendInvite() {
  const qc = useQueryClient();
  return useMutation<ResendInviteResult, Error, string>({
    mutationFn: (userId: string) => resendInvite(userId),
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

/**
 * D.46/D.54 — update an agent's capability set. Capabilities are NOT in
 * the JWT (loaded server-side per request), so no session revocation is
 * needed; we invalidate the members list so the new flags are reflected.
 */
export function useUpdateMemberCapabilities() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; body: UpdateAgentCapabilities }) =>
      updateMemberCapabilities(input.userId, input.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MEMBERS_KEY });
    },
  });
}

/**
 * S4b #8 — the code-defined capability-preset catalog. Static for the
 * session (it's CODE, not per-org data) — a long staleTime is fine.
 * members.read-gated server-side.
 */
export function useCapabilityPresets() {
  return useQuery({
    queryKey: [...MEMBERS_KEY, 'capability-presets'],
    queryFn: () => listCapabilityPresets(),
    staleTime: 5 * 60_000,
  });
}

/**
 * S4b #8 — apply a named capability preset to an agent. Same invalidation as
 * useUpdateMemberCapabilities (the members list reflects the new flags); the
 * BE delegates to the capabilities path so all its rules apply.
 */
export function useApplyCapabilityPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; body: ApplyCapabilityPreset }) =>
      applyCapabilityPreset(input.userId, input.body),
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

// ───────────────────────────────────────────────────────────────────
// P2 Phase 2 — per-user permission OVERRIDES (Owner/Admin only; the
// PUT/DELETE endpoints are roles.manage-gated server-side, and the UI is
// gated on useHasPermission('roles.manage')). A set/clear changes the
// member's effective set → the BE kills their sessions; we invalidate the
// override list so the panel reflects the new layer.
// ───────────────────────────────────────────────────────────────────
const OVERRIDES_KEY = (userId: string) => [...MEMBERS_KEY, 'overrides', userId] as const;

export function useMemberOverrides(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: OVERRIDES_KEY(userId ?? ''),
    queryFn: () => listMemberOverrides(userId as string),
    enabled: enabled && !!userId,
    staleTime: 30_000,
  });
}

export function useSetMemberOverride(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetMemberOverride) => setMemberOverride(userId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OVERRIDES_KEY(userId) });
    },
  });
}

export function useClearMemberOverride(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ClearMemberOverride) => clearMemberOverride(userId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OVERRIDES_KEY(userId) });
    },
  });
}
