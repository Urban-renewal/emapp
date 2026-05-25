'use client';

import type { CreateProject } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toProjectViewModel, toProjectViewModels } from '@/adapters/project';
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  type ProjectListPage,
} from '@/lib/api/projects';
import { useDisplayLocale } from '@/lib/locale';
import type { ProjectViewModel } from '@/models/project.vm';

/**
 * Project data hooks — TanStack Query as the single cache.
 *
 * §SOLID-M6 — `useDisplayLocale()` from `lib/locale` (was a duplicated
 * `he_or_en` helper in 7 hook files).
 *
 * §PERF-H3 closure — `select` callbacks are now memoised via
 * `useCallback` keyed on `locale`. Without this, TanStack v5's
 * `structuralSharing` cannot dedupe because the inline arrow allocates
 * a new function identity AND a new wrapper object literal on every
 * render, defeating the focus-driven re-fetch dedupe. The memoised
 * variant means components only re-render when the wire row count or
 * an item's stable id changes.
 */

const PROJECTS_KEY = ['projects'] as const;

export function useProjectList(query: { limit?: number; cursor?: string } = {}) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: ProjectListPage) => ({
      items: toProjectViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    ProjectListPage,
    Error,
    { items: ProjectViewModel[]; page: ProjectListPage['page'] }
  >({
    queryKey: [...PROJECTS_KEY, 'list', query, locale],
    queryFn: () => listProjects(query),
    staleTime: 30_000,
    select,
  });
}

export function useProject(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: import('@emapp/shared-types').Project) => toProjectViewModel(data, locale),
    [locale],
  );
  return useQuery({
    queryKey: [...PROJECTS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useProject requires an id');
      return getProject(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
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
