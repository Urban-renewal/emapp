'use client';

import type { DedupCheckResponse } from '@emapp/shared-types';
import { useMutation } from '@tanstack/react-query';

import { dedupCheckDocument, sha256OfBlob } from '@/lib/api/documents';

/**
 * DH4 dedup probe (READ-ONLY) — reuses the EXISTING `POST /documents/dedup-check`
 * seam + the SAME `sha256OfBlob` the upload flow computes for `content_hash`, so
 * the probed hash and the create-declared hash are ONE value (no second hashing
 * implementation to drift). On a file-pick the dropzone fires this; a hit lets it
 * offer "קשר לקיים" vs "העלה בכל זאת".
 *
 * A MUTATION (explicit, user-triggered, non-cached): a re-pick re-probes. 0-retry
 * (mutation default) so a transient failure never replays; the dropzone degrades
 * to "no duplicate" on error (dedup is advisory, never a blocker — a failed probe
 * must NEVER stop a legitimate upload).
 */
export function useDocumentDedup() {
  return useMutation<DedupCheckResponse, Error, File>({
    mutationFn: async (file) => {
      const contentHash = await sha256OfBlob(file);
      return dedupCheckDocument(contentHash);
    },
  });
}
