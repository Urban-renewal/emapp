'use client';

import type { CreateProject } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  toApartmentSignatureProgressViewModels,
  toProjectViewModel,
  toProjectViewModels,
  toSignatureProgressViewModel,
} from '@/adapters/project';
import {
  archiveProject,
  createProject,
  getProject,
  getSignatureProgress,
  getSignatureProgressApartments,
  listProjects,
  type ProjectListPage,
} from '@/lib/api/projects';
import { useDisplayLocale } from '@/lib/locale';
import type { ApartmentSignatureProgressViewModel } from '@/models/apartment-signature-progress.vm';
import type { ProjectViewModel } from '@/models/project.vm';
import type { SignatureProgressViewModel } from '@/models/signature-progress.vm';

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

// Query-key builders live in a PLAIN module so the server RSC prefetch can
// call them too (a `'use client'` export cannot be invoked from the server).
import { PROJECTS_KEY, projectsListQueryKey } from './use-projects.keys';

export { projectsListQueryKey };

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
    queryKey: projectsListQueryKey(query, locale),
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

/**
 * Phase-6 "תמונת מצב" — project signature-progress board (S5a, read-only).
 * Returns the adapted VM (board copy + bar color derived in the adapter). The
 * wire carries only counts + the project's own pct — no PII.
 */
export function useSignatureProgress(id: string | undefined) {
  const select = useCallback(
    (data: import('@emapp/shared-types').SignatureProgress): SignatureProgressViewModel =>
      toSignatureProgressViewModel(data),
    [],
  );
  return useQuery({
    queryKey: [...PROJECTS_KEY, 'signature-progress', id],
    queryFn: () => {
      if (!id) throw new Error('useSignatureProgress requires an id');
      return getSignatureProgress(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

/**
 * Phase-6 "תמונת מצב" — per-apartment drill-down (S5d, read-only). Lives under
 * the S5a board; its own query key so it can be lazily enabled (the expandable
 * section only fetches once opened). Returns the adapted VM list (designation +
 * chip color derived in the adapter). The wire carries only counts + apartment
 * designation — no PII.
 */
export function useSignatureProgressApartments(id: string | undefined, enabled = true) {
  const select = useCallback(
    (
      data: import('@emapp/shared-types').ApartmentSignatureProgress[],
    ): ApartmentSignatureProgressViewModel[] => toApartmentSignatureProgressViewModels(data),
    [],
  );
  return useQuery({
    queryKey: [...PROJECTS_KEY, 'signature-progress-apartments', id],
    queryFn: () => {
      if (!id) throw new Error('useSignatureProgressApartments requires an id');
      return getSignatureProgressApartments(id);
    },
    enabled: Boolean(id) && enabled,
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
