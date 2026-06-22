'use client';

import type { CreateProject, ProjectSegment, ProjectStatus } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toDocumentChecklistViewModel } from '@/adapters/document-checklist';
import {
  toApartmentHoldoutViewModels,
  toApartmentSignatureProgressViewModels,
  toProjectLeverageViewModel,
  toProjectViewModel,
  toProjectViewModels,
  toSignatureProgressViewModel,
} from '@/adapters/project';
import { isPermissionDenied } from '@/components/ui/list-page-shell';
import {
  archiveProject,
  createProject,
  getApartmentHoldouts,
  getDocumentChecklist,
  getProject,
  getProjectLeverage,
  getSignatureProgress,
  getSignatureProgressApartments,
  listProjects,
  type ProjectListPage,
} from '@/lib/api/projects';
import { useDisplayLocale } from '@/lib/locale';
import type {
  ApartmentHoldoutViewModel,
  ApartmentSignatureProgressViewModel,
} from '@/models/apartment-signature-progress.vm';
import type { DocumentChecklistViewModel } from '@/models/document-checklist.vm';
import type { ProjectLeverageViewModel } from '@/models/project-leverage.vm';
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
import {
  PROJECTS_KEY,
  projectDocumentChecklistQueryKey,
  projectQueryKey,
  projectsListQueryKey,
} from './use-projects.keys';

export { projectQueryKey, projectsListQueryKey };

/**
 * NS6 (MASTER-PLAN-V13 Wave C) — `query` now carries the optional NS1
 * server-search params (`q` / `status` / `segment`). They flow into BOTH the
 * `queryKey` (so each distinct search caches independently) and the
 * `listProjects` queryFn (so the BE does the filtering, not a client-side
 * `.filter()` over a single page). With all three absent the hook is
 * byte-identical to the pre-NS6 call.
 */
export function useProjectList(
  query: {
    limit?: number;
    cursor?: string;
    q?: string;
    status?: ProjectStatus;
    segment?: ProjectSegment;
  } = {},
) {
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
    // `projectQueryKey` requires a string id; before the `enabled` gate fires
    // the hook may run with `id === undefined`, so fall back to '' for the key
    // shape (the query never actually runs while disabled).
    queryKey: projectQueryKey(id ?? '', locale),
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
 * Battle-Map BM-1 — project LEVERAGE card ("מפת קרב" entry, read-only). Returns
 * the adapted VM (the single top-leverage owner reshaped + bidi-stripped in the
 * adapter). The ONLY PII is the owner name, `view_owner_pii`-gated on the BE
 * (already `null` when masked); national_id / phone never appear. Own query key
 * so it self-fetches inside the card, never as a first-mount page query.
 */
export function useProjectLeverage(id: string | undefined) {
  const select = useCallback(
    (data: import('@emapp/shared-types').ProjectLeverage): ProjectLeverageViewModel =>
      toProjectLeverageViewModel(data),
    [],
  );
  return useQuery({
    queryKey: [...PROJECTS_KEY, 'leverage', id],
    queryFn: () => {
      if (!id) throw new Error('useProjectLeverage requires an id');
      return getProjectLeverage(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

/**
 * DH2 (V13) — the ADVISORY per-project required-docs checklist. Drives the
 * "מסמכי חובה: present מתוך total · חסר: …" line + the quiet missing-type chips
 * in each project group on the documents page. The wire carries NO PII (only
 * doc-type keys + present booleans + counts); the adapter resolves the MISSING
 * types to localized labels. `enabled`-gated so each group fetches lazily and
 * only for the projects actually shown on the current keyset page.
 */
export function useDocumentChecklist(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: import('@emapp/shared-types').DocumentChecklist): DocumentChecklistViewModel =>
      toDocumentChecklistViewModel(data, locale),
    [locale],
  );
  return useQuery({
    queryKey: projectDocumentChecklistQueryKey(id ?? '', locale),
    queryFn: () => {
      if (!id) throw new Error('useDocumentChecklist requires an id');
      return getDocumentChecklist(id);
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

/**
 * E2 Wave-2 E2.2-S3 / B4 — apartment HOLDOUTS ("מי תקוע / who's stuck"). The
 * NAMED list of an apartment's owners who have NOT signed.
 *
 * PII-bearing + ON DEMAND: this is the only signature-progress hook that pulls
 * owner NAMES, so the underlying endpoint is `view_owner_pii`-gated + AUDITED on
 * the BE. The hook is therefore lazily enabled (`enabled` gate) — the caller
 * passes `true` only when an apartment row is EXPANDED, so the names + the audit
 * fire on demand, never eagerly for the whole board.
 *
 * A 403 (caller lacks `view_owner_pii`) is NOT retried (the global query-provider
 * never retries a definitive 4xx) and is surfaced via `isError` + the
 * `ApiClientError` code so the component renders the NO-NAME fallback
 * ("דירה N · partial") instead of a name. The query key includes the
 * apartmentId so each expanded apartment caches independently.
 */
export function useApartmentHoldouts(
  projectId: string,
  apartmentId: string | undefined,
  enabled = true,
) {
  const select = useCallback(
    (data: import('@emapp/shared-types').ApartmentHoldout[]): ApartmentHoldoutViewModel[] =>
      toApartmentHoldoutViewModels(data),
    [],
  );
  return useQuery({
    queryKey: [...PROJECTS_KEY, 'apartment-holdouts', projectId, apartmentId],
    queryFn: () => {
      if (!apartmentId) throw new Error('useApartmentHoldouts requires an apartmentId');
      return getApartmentHoldouts(projectId, apartmentId);
    },
    enabled: Boolean(apartmentId) && enabled,
    staleTime: 30_000,
    select,
  });
}

/** Re-export so the drill-down can classify a holdouts 403 (→ no-name fallback)
 *  vs a generic load error (→ calm retry) without re-importing the predicate. */
export { isPermissionDenied };

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
