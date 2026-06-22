'use client';

import type { CreateImport, ImportJob, SubmitMapping } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toImportViewModel, toImportViewModels } from '@/adapters/import';
import {
  cancelImport,
  confirmImport,
  createImport,
  getImport,
  hexSha256ToBase64,
  listImportErrors,
  listImports,
  sha256OfBlob,
  startImport,
  submitMapping,
  uploadToPresignedXhr,
  type ImportErrorListPage,
  type ImportListPage,
} from '@/lib/api/imports';
import { useDisplayLocale } from '@/lib/locale';
import type { ImportViewModel } from '@/models/import.vm';

const IMPORTS_KEY = ['imports'] as const;

export function useImportList(query: { limit?: number; cursor?: string; projectId?: string } = {}) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: ImportListPage) => ({
      items: toImportViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    ImportListPage,
    Error,
    { items: ImportViewModel[]; page: ImportListPage['page'] }
  >({
    queryKey: [...IMPORTS_KEY, 'list', query, locale],
    queryFn: () => listImports(query),
    staleTime: 30_000,
    select,
  });
}

export function useImport(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback((data: ImportJob) => toImportViewModel(data, locale), [locale]);
  return useQuery({
    queryKey: [...IMPORTS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useImport requires an id');
      return getImport(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

export function useImportErrors(id: string | undefined) {
  return useQuery<ImportErrorListPage>({
    queryKey: [...IMPORTS_KEY, 'errors', id],
    queryFn: () => {
      if (!id) throw new Error('useImportErrors requires an id');
      return listImportErrors(id, { limit: 100 });
    },
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/**
 * 3-phase upload: create (presigned PUT) → XHR PUT to R2 → start.
 * `onProgress(loaded, total)` surfaces upload-byte progress so the UI
 * can show a real upload bar (fetch() doesn't expose this).
 */
export function useUploadImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      projectId: string;
      file: File;
      dryRun?: boolean;
      requireConfirm?: boolean;
      onProgress?: (loaded: number, total: number) => void;
    }) => {
      const contentHash = await sha256OfBlob(args.file);
      const body: CreateImport = {
        projectId: args.projectId,
        fileName: args.file.name,
        fileSizeBytes: args.file.size,
        fileContentHash: contentHash,
        dryRun: args.dryRun ?? false,
        requireConfirm: args.requireConfirm ?? false,
      };
      const created = await createImport(body);
      const mime =
        args.file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      // B7 — the BE signed `If-None-Match: *` + `x-amz-checksum-sha256` into the
      // presigned URL (create-only + checksum-bound, mirroring documents #500).
      // Send the SAME sha256 we declared at create (base64-of-raw-digest) so the
      // bound checksum and the sent checksum match; R2 rejects otherwise.
      await uploadToPresignedXhr(created.uploadUrl, args.file, mime, args.onProgress, {
        createOnly: true,
        contentSha256Base64: hexSha256ToBase64(contentHash),
      });
      const started = await startImport(created.import.id);
      return started;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: IMPORTS_KEY });
    },
  });
}

export function useCancelImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelImport(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: IMPORTS_KEY });
    },
  });
}

export function useConfirmImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => confirmImport(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: IMPORTS_KEY });
    },
  });
}

export function useSubmitMapping(importId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SubmitMapping) => submitMapping(importId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: IMPORTS_KEY });
    },
  });
}
