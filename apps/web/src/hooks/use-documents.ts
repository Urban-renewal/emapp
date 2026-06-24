'use client';

import type { BoardCompleteness, Document } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toDocumentViewModel, toDocumentViewModels } from '@/adapters/document';
import { toDocumentsBoardViewModel } from '@/adapters/documents-board';
import {
  archiveDocument,
  fetchDownload,
  getBoardCompleteness,
  getDocument,
  listDocuments,
  searchDocuments,
  uploadDocumentFlow,
  type DocumentDownloadResult,
  type DocumentListPage,
  type DocumentSearchArgs,
  type UploadDocumentArgs,
} from '@/lib/api/documents';
import { useDisplayLocale } from '@/lib/locale';
import type { DocumentViewModel } from '@/models/document.vm';
import type { DocumentsBoardViewModel } from '@/models/documents-board.vm';

import {
  DOCUMENTS_KEY,
  documentsBoardCompletenessQueryKey,
  documentsListQueryKey,
  documentsSearchQueryKey,
} from './use-documents.keys';
import { PROJECTS_KEY } from './use-projects.keys';

export { documentsListQueryKey };

export function useDocumentList(
  query: {
    limit?: number;
    cursor?: string;
    projectId?: string;
    apartmentId?: string;
    archived?: boolean;
  } = {},
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: DocumentListPage) => ({
      items: toDocumentViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    DocumentListPage,
    Error,
    { items: DocumentViewModel[]; page: DocumentListPage['page'] }
  >({
    queryKey: documentsListQueryKey(query, locale),
    queryFn: () => listDocuments({ limit: query.limit ?? 25, ...query }),
    staleTime: 30_000,
    select,
  });
}

/**
 * PARTY-BINDER board completeness — per-party required-vs-received over the
 * WHOLE board scope, computed server-side. The board cannot derive this from
 * its 25-doc keyset page (it would mis-count requirements across unloaded
 * projects). Fail-SOFT: a failed/parse-rejected response leaves `data`
 * undefined and the board renders WITHOUT completeness badges (the calm
 * slice-1 "present" check) — completeness is an enhancement, never a blocker.
 * No locale in the key: the response is counts + doc-type keys (label-resolved
 * at the component), identical across locales.
 */
export function useBoardCompleteness() {
  return useQuery({
    queryKey: documentsBoardCompletenessQueryKey(),
    queryFn: getBoardCompleteness,
    staleTime: 30_000,
  });
}

/**
 * S2 (org cockpit) — the documents board as a SITUATION-PICTURE VM. Reuses the
 * SAME `board-completeness` query (one cache, the upload/archive mutations
 * already invalidate it) but maps the wire through `toDocumentsBoardViewModel`
 * so the cockpit gets the project-attention axis (ranked behind projects +
 * pulse + completeness-aware tiles) pre-derived. The locale-aware `select`
 * resolves the missing-type labels exactly like the other documents hooks; the
 * shared (locale-less) query key keeps ONE cache + the existing invalidation.
 */
export function useDocumentsBoard() {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: BoardCompleteness): DocumentsBoardViewModel => toDocumentsBoardViewModel(data, locale),
    [locale],
  );
  return useQuery<BoardCompleteness, Error, DocumentsBoardViewModel>({
    queryKey: documentsBoardCompletenessQueryKey(),
    queryFn: getBoardCompleteness,
    staleTime: 30_000,
    select,
  });
}

/**
 * NS1 server-side document search (Phase 1) — the board search box + the
 * per-party board zoom-in hit `GET /documents/search` directly (not a filter
 * over one loaded page). `q` is required; `enabled` gates the query off until
 * the caller has a non-empty `q` (a board zoom-in by `party` alone still needs a
 * `q` — pass the search term or a board-wide token the caller controls). The
 * VM-mapped `select` resolves localized labels exactly like `useDocumentList`,
 * so the board renders the same card shape for list + search results.
 */
export function useDocumentSearch(args: DocumentSearchArgs, options?: { enabled?: boolean }) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: DocumentListPage) => ({
      items: toDocumentViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  const hasQuery = args.q.trim().length > 0;
  return useQuery<
    DocumentListPage,
    Error,
    { items: DocumentViewModel[]; page: DocumentListPage['page'] }
  >({
    queryKey: documentsSearchQueryKey(args, locale),
    queryFn: () => searchDocuments({ limit: args.limit ?? 25, ...args }),
    enabled: hasQuery && (options?.enabled ?? true),
    staleTime: 30_000,
    select,
  });
}

export function useDocument(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback((data: Document) => toDocumentViewModel(data, locale), [locale]);
  return useQuery({
    queryKey: [...DOCUMENTS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useDocument requires an id');
      return getDocument(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

/** Orchestrates the upload (7d dual-mode — see uploadDocumentFlow):
 *  plain doc:     create → PUT to presigned R2 URL → finalize (unchanged);
 *  sensitive doc: create (uploadUrl null + contentUploadPath) → POST raw
 *                 bytes to the API content path → done (NO finalize — the
 *                 content route stamps uploaded itself; finalize would 409). */
export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: UploadDocumentArgs) => uploadDocumentFlow(args),
    onSuccess: (_doc, args) => {
      // The new doc changes (a) every documents list/search page, (b) the board
      // SUMMARY (per-party total + latest), and (c) the per-project advisory
      // CHECKLIST (a freshly-uploaded required type flips present:false→true).
      // Pre-Phase-1 only (a) was invalidated, so the project docs-tab checklist
      // + the board tiles went stale after an upload (the "dead/ stale" bug).
      // All three are invalidated here by their canonical keys.
      qc.invalidateQueries({ queryKey: DOCUMENTS_KEY });
      qc.invalidateQueries({ queryKey: documentsBoardCompletenessQueryKey() });
      // Checklist is locale-keyed AND per-project. Prefix-invalidate the
      // document-checklist family so EVERY locale variant refreshes; scope to the
      // uploaded doc's project when known (else the whole checklist family).
      if (args.projectId) {
        qc.invalidateQueries({
          queryKey: [...PROJECTS_KEY, 'document-checklist', args.projectId],
        });
      } else {
        qc.invalidateQueries({ queryKey: [...PROJECTS_KEY, 'document-checklist'] });
      }
    },
  });
}

export function useArchiveDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveDocument(id),
    onSuccess: () => {
      // Archiving removes a doc from the board → the board SUMMARY counts + a
      // per-project checklist slot can flip present:true→false. Invalidate all
      // three families (the archive mutation only has the id, not the project,
      // so the checklist is invalidated family-wide).
      qc.invalidateQueries({ queryKey: DOCUMENTS_KEY });
      qc.invalidateQueries({ queryKey: documentsBoardCompletenessQueryKey() });
      qc.invalidateQueries({ queryKey: [...PROJECTS_KEY, 'document-checklist'] });
    },
  });
}

/** Resolve a download (7d dual-mode): plain docs → `{ kind: 'presign',
 *  url }` (short-lived presigned GET, opened in a new tab); sensitive
 *  docs → `{ kind: 'bytes', blob, filename }` (the API decrypt-streamed
 *  the object — a presigned URL would serve ciphertext). The disposition
 *  still selects save-dialog vs in-tab rendering on BOTH legs. 0 retries
 *  (mutation default) so a click never replays. */
export function useDownloadDocument() {
  return useMutation<
    DocumentDownloadResult,
    Error,
    { id: string; disposition?: 'inline' | 'attachment' }
  >({
    mutationFn: (args) => fetchDownload(args.id, args.disposition ?? 'attachment'),
  });
}
