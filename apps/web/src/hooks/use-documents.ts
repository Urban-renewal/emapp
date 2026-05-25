'use client';

import type { Document } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toDocumentViewModel, toDocumentViewModels } from '@/adapters/document';
import {
  archiveDocument,
  canonicalMime,
  createDocument,
  finalizeDocument,
  getDocument,
  getDownloadUrl,
  listDocuments,
  sha256OfBlob,
  uploadToPresigned,
  type DocumentListPage,
} from '@/lib/api/documents';
import { useDisplayLocale } from '@/lib/locale';
import type { DocumentViewModel } from '@/models/document.vm';

const DOCUMENTS_KEY = ['documents'] as const;

export function useDocumentList(
  query: {
    limit?: number;
    cursor?: string;
    projectId?: string;
    apartmentId?: string;
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
    queryKey: [...DOCUMENTS_KEY, 'list', query, locale],
    queryFn: () => listDocuments({ limit: query.limit ?? 25, ...query }),
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

/** Orchestrates the 3-phase upload: create → PUT to R2 → finalize. */
export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      file: File;
      type: import('@emapp/shared-types').DocumentType;
      mimeType: import('@emapp/shared-types').DocumentMime;
      projectId?: string;
      apartmentId?: string;
    }) => {
      const contentHash = await sha256OfBlob(args.file);
      // §v9-M-3 — canonicalize the mime ONCE so the signed Content-
      // Type at create-time matches what we PUT to R2.
      const mimeType = canonicalMime(args.mimeType) as typeof args.mimeType;
      const created = await createDocument({
        name: args.file.name,
        type: args.type,
        mimeType,
        sizeBytes: args.file.size,
        contentHash,
        projectId: args.projectId ?? null,
        apartmentId: args.apartmentId ?? null,
      });
      await uploadToPresigned(created.uploadUrl, args.file, mimeType);
      const finalized = await finalizeDocument(created.document.id, {
        sizeBytes: args.file.size,
        contentHash,
      });
      return finalized;
    },
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

export function useDownloadDocument() {
  return useMutation({
    mutationFn: (id: string) => getDownloadUrl(id),
  });
}
