'use client';

import type { Document } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toDocumentViewModel, toDocumentViewModels } from '@/adapters/document';
import {
  archiveDocument,
  fetchDownload,
  getBoardCompleteness,
  getDocument,
  listDocuments,
  uploadDocumentFlow,
  type DocumentDownloadResult,
  type DocumentListPage,
  type UploadDocumentArgs,
} from '@/lib/api/documents';
import { useDisplayLocale } from '@/lib/locale';
import type { DocumentViewModel } from '@/models/document.vm';

import { DOCUMENTS_KEY, documentsListQueryKey } from './use-documents.keys';

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
    queryKey: [...DOCUMENTS_KEY, 'board-completeness'],
    queryFn: getBoardCompleteness,
    staleTime: 30_000,
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCUMENTS_KEY });
    },
  });
}

export function useArchiveDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveDocument(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DOCUMENTS_KEY });
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
