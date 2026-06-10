'use client';

import type {
  AssignRole,
  CreateCustomRole,
  RevokeRole,
  UpdateCustomRole,
} from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  assignRole,
  createRole,
  deleteRole,
  getPermissionCatalog,
  listRoles,
  revokeRole,
  updateRole,
} from '@/lib/api/roles';

/**
 * Roles data hooks — TanStack Query (P2 Phase 1).
 *
 * Mirrors `use-members.ts`: 30s staleTime; mutations invalidate the roles list.
 * Assign/revoke ALSO invalidate the members list (a grant changes the member's
 * effective role) and `['session']` (the actor's own effective set may shift if
 * they self-target — though the BE forbids self-grant, a revoke of another
 * Owner can still matter for the roster).
 */
const ROLES_KEY = ['roles'] as const;

export function useRoles() {
  return useQuery({
    queryKey: [...ROLES_KEY, 'list'],
    queryFn: listRoles,
    staleTime: 30_000,
  });
}

export function usePermissionCatalog() {
  return useQuery({
    queryKey: [...ROLES_KEY, 'catalog'],
    // The catalog is effectively static (it changes only on a BE deploy).
    queryFn: getPermissionCatalog,
    staleTime: 60 * 60 * 1000,
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCustomRole) => createRole(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ROLES_KEY }),
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: UpdateCustomRole }) => updateRole(input.id, input.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ROLES_KEY }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRole(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ROLES_KEY }),
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AssignRole) => assignRole(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROLES_KEY });
      qc.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export function useRevokeRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RevokeRole) => revokeRole(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROLES_KEY });
      qc.invalidateQueries({ queryKey: ['members'] });
    },
  });
}
