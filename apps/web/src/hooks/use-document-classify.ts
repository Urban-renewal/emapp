'use client';

import type { ClassifyResult, DocumentMime } from '@emapp/shared-types';
import { useMutation } from '@tanstack/react-query';

import { classifyDocument, leadingBytesBase64 } from '@/lib/api/documents';

/**
 * DH3 classifier (SUGGEST-ONLY) — reuses the EXISTING `POST /documents/classify`
 * seam. On a file-pick the dropzone fires this to learn the ranked doc_type
 * suggestions; the band logic (`lib/document-classify.ts`) then decides AUTO /
 * CONFIRM / ASK. A MUTATION (not a query): it is an explicit, user-triggered,
 * non-cached probe (a re-pick re-runs it), and 0-retry by default so a transient
 * failure never replays — the dropzone degrades to ASK on error (the classifier
 * is advisory, never a blocker).
 *
 * Sends the filename + declared mime ALWAYS, plus the file's LEADING bytes
 * (base64, capped at 8KiB by `leadingBytesBase64`) so the content sniff
 * (נסח/טאבו → land_registry) can fire. The bytes are never logged/stored (BE
 * contract) and the slice is small.
 */
export interface ClassifyPickArgs {
  file: File;
  mimeType: DocumentMime;
}

export function useDocumentClassify() {
  return useMutation<ClassifyResult, Error, ClassifyPickArgs>({
    mutationFn: async ({ file, mimeType }) => {
      const sampleBase64 = await leadingBytesBase64(file);
      return classifyDocument({ filename: file.name, mimeType, sampleBase64 });
    },
  });
}
