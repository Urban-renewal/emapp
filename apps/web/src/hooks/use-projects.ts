'use client';

import type { CreateProject } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { toProjectViewModel, toProjectViewModels } from '@/adapters/project';
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  type ProjectListPage,
} from '@/lib/api/projects';
import type { ProjectViewModel } from '@/models/project.vm';

/**
 * Project data hooks — TanStack Query as the single cache. The adapter
 * (Wire → ViewModel) runs in `select` so components consume
 * `ProjectViewModel[]` directly; React Query memoizes by reference, so
 * the adapter only re-runs when the underlying data changes.
 *
 * Per docs/03 Phase 8 perf rules: `staleTime: 30_000` — 30s is a safe
 * compromise (the API list is cursor-paginated and indexed; refetches
 * happen on focus + invalidation after mutations anyway).
 */

const PROJECTS_KEY = ['projects'] as const;

export function useProjectList(query: { limit?: number; cursor?: string } = {}) {
  return useQuery<
    ProjectListPage,
    Error,
    { items: ProjectViewModel[]; page: ProjectListPage['page'] }
  >({
    queryKey: [...PROJECTS_KEY, 'list', query],
    queryFn: () => listProjects(query),
    staleTime: 30_000,
    select: (data) => ({ items: toProjectViewModels(data.items), page: data.page }),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: [...PROJECTS_KEY, 'one', id],
    queryFn: () => {
      if (!id) throw new Error('useProject requires an id');
      return getProject(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select: (data) => toProjectViewModel(data),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProject) => createProject(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useArchiveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}
