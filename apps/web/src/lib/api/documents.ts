/**
 * Documents API client (D.28).
 *
 * Confidentiality posture:
 *  - r2_key is NEVER on the wire — the FE never receives a key. POST
 *    /documents returns `{ document, uploadUrl, uploadExpiresInSeconds }`
 *    where uploadUrl is a short-lived presigned PUT (5 min).
 *  - GET /documents/:id/download returns `{ url, expiresInSeconds }` —
 *    a short-lived presigned GET (2 min). The FE opens it as an
 *    attachment.
 *  - Finalize verifies size+hash; mismatch → server archives + purges.
 *  - MIME is an allow-list (enforced by shared-types DocumentMimeEnum).
 *  - 50 MB hard ceiling.
 */
import {
  DocumentDownloadResponseSchema,
  DocumentSchema,
  DocumentUploadResponseSchema,
  type CreateDocument,
  type Document,
  type FinalizeDocument,
  type ListDocumentsQueryDto,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './projects';

const DocumentDataSchema = z.object({ data: DocumentSchema });
const UploadResponseDataSchema = z.object({ data: DocumentUploadResponseSchema });
const DownloadResponseDataSchema = z.object({ data: DocumentDownloadResponseSchema });
const PageSchema = z.object({
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export interface DocumentListPage {
  items: Document[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listDocuments(query: ListDocumentsQueryDto): Promise<DocumentListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.apartmentId) params.set('apartmentId', query.apartmentId);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/documents${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(DocumentSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getDocument(id: string): Promise<Document> {
  const res = await apiClient.get<unknown>(`/documents/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DocumentDataSchema.parse({ data: res.data }).data;
}

/** POST /documents — declare metadata, get back a presigned PUT URL. */
export async function createDocument(
  body: CreateDocument,
): Promise<{ document: Document; uploadUrl: string; uploadExpiresInSeconds: number }> {
  const res = await apiClient.post<unknown>(`/documents`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return UploadResponseDataSchema.parse({ data: res.data }).data;
}

/** POST /documents/:id/finalize — confirm the upload matched the
 *  declared size + hash. Server cross-checks with R2 metadata. */
export async function finalizeDocument(id: string, body: FinalizeDocument): Promise<Document> {
  const res = await apiClient.post<unknown>(`/documents/${id}/finalize`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DocumentDataSchema.parse({ data: res.data }).data;
}

/** GET /documents/:id/download — receive a short-lived presigned GET URL.
 *  The FE then opens it as an attachment. Never log this URL. */
export async function getDownloadUrl(
  id: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  const res = await apiClient.get<unknown>(`/documents/${id}/download`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DownloadResponseDataSchema.parse({ data: res.data }).data;
}

export async function archiveDocument(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/documents/${id}`);
  if (isOk(res)) return;
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}

/**
 * Direct upload to R2 via the presigned PUT URL. NOT through the proxy
 * (the URL is bound to R2's origin); we send Content-Type +
 * Content-Length. No cookies, no Authorization — the URL signature IS
 * the credential.
 */
export async function uploadToPresigned(url: string, blob: Blob, mimeType: string): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': mimeType },
  });
  if (!res.ok) {
    throw new ApiClientError({
      code: 'upload_failed',
      message: `R2 upload returned ${res.status}`,
    });
  }
}

/** Compute SHA-256 of a Blob — used as the document content hash. */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
