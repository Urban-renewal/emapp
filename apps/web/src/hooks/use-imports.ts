'use client';

import type { CreateImport, SubmitMapping } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import { toImportViewModel, toImportViewModels } from '@/adapters/import';
import {
  cancelImport,
  createImport,
  getImport,
  listImportErrors,
  listImports,
  sha256OfBlob,
  startImport,
  submitMapping,
  uploadToPresignedXhr,
  type ImportErrorListPage,
  type ImportListPage,
} from '@/lib/api/imports';
import type { ImportViewModel } from '@/models/import.vm';

const IMPORTS_KEY = ['imports'] as const;
function he_or_en(loc: string): 'he' | 'en' {
  return loc === 'en' ? 'en' : 'he';
}

export function useImportList(query: { limit?: number; cursor?: string; projectId?: string } = {}) {
  const locale = he_or_en(useLocale());
  return useQuery<
    ImportListPage,
    Error,
    { items: ImportViewModel[]; page: ImportListPage['page'] }
  >({
    queryKey: [...IMPORTS_KEY, 'list', query, locale],
    queryFn: () => listImports(query),
    staleTime: 30_000,
    select: (data) => ({ items: toImportViewModels(data.items, locale), page: data.page }),
  });
}

export function useImport(id: string | undefined) {
  const locale = he_or_en(useLocale());
  return useQuery({
    queryKey: [...IMPORTS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useImport requires an id');
      return getImport(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select: (data) => toImportViewModel(data, locale),
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
      onProgress?: (loaded: number, total: number) => void;
    }) => {
      const contentHash = await sha256OfBlob(args.file);
      // CreateImportInput requires fileContentHash to match
      // /^[0-9a-f]{64}$/ — bare hex (v8 SOLID-2). sha256OfBlob
      // produces that exact shape.
      const body: CreateImport = {
        projectId: args.projectId,
        fileName: args.file.name,
        fileSizeBytes: args.file.size,
        fileContentHash: contentHash,
        dryRun: args.dryRun ?? false,
      };
      const created = await createImport(body);
      // R2-bound mime — Excel files report
      // application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
      // on modern browsers; older may use application/vnd.ms-excel.
      const mime =
        args.file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      await uploadToPresignedXhr(created.uploadUrl, args.file, mime, args.onProgress);
      // Now enqueue the worker job.
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

export function useSubmitMapping(importId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SubmitMapping) => submitMapping(importId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: IMPORTS_KEY });
    },
  });
}
