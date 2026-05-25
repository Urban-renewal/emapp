'use client';

import type { CreateProjectAssignment } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  toProjectAssignmentViewModels,
  type AssignmentMemberLookup,
} from '@/adapters/project-assignment';
import {
  createProjectAssignment,
  listProjectAssignments,
  unassignProjectAssignment,
  type ProjectAssignmentListPage,
} from '@/lib/api/assignments';
import { useDisplayLocale } from '@/lib/locale';
import type { ProjectAssignmentViewModel } from '@/models/project-assignment.vm';

/**
 * Project assignments — TanStack hooks (same shape as use-members / use-projects).
 *
 * Per-project query key includes the projectId; mutations invalidate
 * only their project's slice so an unassign on project A doesn't
 * refetch project B's list.
 */
const ASSIGNMENTS_KEY = ['assignments'] as const;

export function useProjectAssignmentList(
  projectId: string | undefined,
  query: { limit?: number; cursor?: string } = {},
  /** Member lookup map (Manager-only enrichment). Pass `undefined`
   *  for Agent/Viewer — the adapter degrades to userIdShort. */
  userIdToMember?: Map<string, AssignmentMemberLookup>,
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: ProjectAssignmentListPage) => ({
      items: toProjectAssignmentViewModels(data.items, locale, userIdToMember),
      page: data.page,
    }),
    // The lookup map identity matters — when it changes (e.g. members
    // refetch resolves), the adapter must re-run.
    [locale, userIdToMember],
  );
  return useQuery<
    ProjectAssignmentListPage,
    Error,
    { items: ProjectAssignmentViewModel[]; page: ProjectAssignmentListPage['page'] }
  >({
    queryKey: [...ASSIGNMENTS_KEY, 'list', projectId, query, locale],
    queryFn: () => {
      if (!projectId) throw new Error('useProjectAssignmentList requires a projectId');
      return listProjectAssignments(projectId, query);
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
    select,
  });
}

export function useCreateProjectAssignment(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectAssignment) => {
      if (!projectId) throw new Error('useCreateProjectAssignment requires a projectId');
      return createProjectAssignment(projectId, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ASSIGNMENTS_KEY, 'list', projectId] });
    },
  });
}

export function useUnassignProjectAssignment(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unassignProjectAssignment(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ASSIGNMENTS_KEY, 'list', projectId] });
    },
  });
}
