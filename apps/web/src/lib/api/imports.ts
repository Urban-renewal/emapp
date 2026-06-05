/**
 * Imports API client (D.34).
 *
 * 3-phase upload flow:
 *   1. POST /imports — declare metadata + receive presigned PUT URL
 *      (5-min TTL; storage key NEVER on the wire). Idempotency-Key
 *      auto-minted per call (Doc 06 §5.7).
 *   2. Browser PUT directly to R2 (`credentials: 'omit'` —
 *      v9-post-audit-CRITICAL). XHR body is the Excel blob, signed
 *      Content-Type bound by the presigning step.
 *   3. POST /imports/:id/start — enqueue the worker job. Server's
 *      `started_at IS NULL` latch dedups concurrent /start calls
 *      (Sec-3 closure).
 *
 * Wizard slot (D.34): when an import reaches `awaiting_mapping`
 * status, the FE shows a column-mapping UI and POSTs the manager's
 * choices to `/imports/:id/mapping` (SubmitMappingInput). The
 * worker resumes with the saved template.
 *
 * SSE: GET /imports/:id/stream is opened with a native EventSource
 * (NOT through this client — see `useImportProgress` hook).
 */
import {
  CreateImportInput,
  ImportErrorSchema,
  ImportJobSchema,
  ImportUploadResponseSchema,
  SubmitMappingInput,
  SubmitMappingResponseSchema,
  type CreateImport,
  type ImportError,
  type ImportJob,
  type ImportUploadResponse,
  type ListImportErrorsQueryDto,
  type SubmitMapping,
  type SubmitMappingResponse,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const ImportDataSchema = z.object({ data: ImportJobSchema });
const ImportUploadDataSchema = z.object({ data: ImportUploadResponseSchema });
const SubmitMappingDataSchema = z.object({ data: SubmitMappingResponseSchema });

export interface ImportListPage {
  items: ImportJob[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export interface ImportErrorListPage {
  items: ImportError[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listImports(
  query: { limit?: number; cursor?: string; projectId?: string } = {},
): Promise<ImportListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.projectId) params.set('projectId', query.projectId);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/imports${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ImportJobSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getImport(id: string): Promise<ImportJob> {
  const res = await apiClient.get<unknown>(`/imports/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ImportDataSchema.parse({ data: res.data }).data;
}

/**
 * POST /imports — declare metadata + receive presigned PUT URL.
 * Idempotent: a double-clicked Upload won't mint two presigns. Note
 * the BE's `CreateImportInput.idempotencyKey` regex is
 * `^[A-Za-z0-9_-]{16,64}$` — UUIDv4 (36 chars with hyphens) matches.
 */
export async function createImport(body: CreateImport): Promise<ImportUploadResponse> {
  // FE-side defensive parse — never POST a malformed body.
  CreateImportInput.parse(body);
  const res = await apiClient.postIdempotent<unknown>(`/imports`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ImportUploadDataSchema.parse({ data: res.data }).data;
}

/**
 * PUT directly to the presigned URL. NOT through the proxy (the URL
 * is bound to R2's origin). `credentials: 'omit'` per v9-post-audit
 * CRITICAL — presigned URL signature IS the credential; sending
 * cookies or Authorization would either corrupt the signature or
 * leak the bearer token.
 */
export async function uploadToPresignedXhr(
  url: string,
  blob: Blob,
  mimeType: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  // Use XHR (not fetch) for upload-progress events — fetch doesn't
  // surface per-byte upload progress. R2 honors the standard PUT
  // semantics.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else
        reject(
          new ApiClientError({
            code: 'upload_failed',
            message: `R2 upload returned ${xhr.status}`,
          }),
        );
    };
    xhr.onerror = () =>
      reject(new ApiClientError({ code: 'upload_failed', message: 'network error' }));
    xhr.onabort = () => reject(new ApiClientError({ code: 'upload_failed', message: 'aborted' }));
    xhr.send(blob);
  });
}

export async function startImport(id: string): Promise<ImportJob> {
  // Empty body — server only needs the id from the URL path.
  const res = await apiClient.post<unknown>(`/imports/${id}/start`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ImportDataSchema.parse({ data: res.data }).data;
}

/** POST /imports/:id/confirm — 0048 preview→confirm: commit a preview-paused
 *  import (status 'awaiting_confirm'); the server re-queues a real run. */
export async function confirmImport(id: string): Promise<ImportJob> {
  const res = await apiClient.post<unknown>(`/imports/${id}/confirm`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  // Endpoint returns { data: { import: ImportJob } }.
  return z.object({ import: ImportJobSchema }).parse(res.data).import;
}

/** DELETE /imports/:id — cancel (only valid in CANCELLABLE states). */
export async function cancelImport(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/imports/${id}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}

export async function listImportErrors(
  id: string,
  query: ListImportErrorsQueryDto = { limit: 100 },
): Promise<ImportErrorListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/imports/${id}/errors${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ImportErrorSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

/** POST /imports/:id/mapping — D.34 manual wizard submission. */
export async function submitMapping(
  id: string,
  body: SubmitMapping,
): Promise<SubmitMappingResponse> {
  SubmitMappingInput.parse(body);
  const res = await apiClient.post<unknown>(`/imports/${id}/mapping`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return SubmitMappingDataSchema.parse({ data: res.data }).data;
}

/** Compute SHA-256 of a Blob — bare hex, lowercase. Matches
 *  `Sha256HexLowerSchema` in shared-types (v8 SOLID-2 canonical
 *  shape: NO `sha256:` prefix). */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
