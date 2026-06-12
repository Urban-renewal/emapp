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
  type DocumentMime,
  type DocumentUploadResponse,
  type FinalizeDocument,
  type ListDocumentsQueryDto,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const DocumentDataSchema = z.object({ data: DocumentSchema });
const UploadResponseDataSchema = z.object({ data: DocumentUploadResponseSchema });
const DownloadResponseDataSchema = z.object({ data: DocumentDownloadResponseSchema });

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

/** POST /documents — declare metadata, get back a presigned PUT URL.
 *  §v9-P0-3 idempotent (a double-clicked Upload should not mint two
 *  presigned URLs / two DB rows).
 *  7d: a SENSITIVE doc (id_document/financial, or sensitive:true) returns
 *  `uploadUrl: null` + `contentUploadPath` — its bytes go through the API
 *  content path, not a presigned PUT. */
export async function createDocument(body: CreateDocument): Promise<DocumentUploadResponse> {
  const res = await apiClient.postIdempotent<unknown>(`/documents`, body);
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
 *  `disposition` selects the R2 Content-Disposition the presigned URL is
 *  signed for: `attachment` (default) → save dialog; `inline` → the PDF
 *  renders in-tab. Both pass the AV-scan gate (only clean docs).
 *  Never log this URL. */
export async function getDownloadUrl(
  id: string,
  disposition: 'inline' | 'attachment' = 'attachment',
): Promise<{ url: string; expiresInSeconds: number }> {
  const qs = disposition === 'inline' ? '?disposition=inline' : '';
  const res = await apiClient.get<unknown>(`/documents/${id}/download${qs}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DownloadResponseDataSchema.parse({ data: res.data }).data;
}

export async function archiveDocument(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/documents/${id}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}

/**
 * Direct upload to R2 via the presigned PUT URL. NOT through the proxy
 * (the URL is bound to R2's origin); we send Content-Type +
 * Content-Length. No cookies, no Authorization — the URL signature IS
 * the credential.
 *
 * §v9-M-3 — Content-Type pinning. R2 signs the presigned PUT with the
 * exact `mimeType` the FE sent in createDocument. macOS / Windows
 * browsers sometimes report `file.type` as a non-canonical alias
 * (`image/jpg` instead of `image/jpeg`, `application/x-zip-compressed`
 * vs `application/zip`). If the PUT's Content-Type drifts from the
 * signed value, R2 rejects with 403 SignatureDoesNotMatch. We
 * canonicalize on BOTH the create-call mimeType (the caller does it)
 * and the upload-call mimeType (here) using the same map.
 */
/**
 * v9-post-audit-SOLID-11 closure — every map TARGET must be a valid
 * DocumentMimeEnum value. The compile-time `satisfies` ensures a
 * future map entry pointing to a non-canonical value fails `tsc`
 * (e.g. `'image/jpg': 'image/x-jpeg'` would error: not in enum).
 *
 * The KEY side (LHS) is INTENTIONALLY unrestricted: it captures
 * non-canonical aliases that browsers report (image/jpg, image/pjpeg,
 * application/x-zip-compressed, text/comma-separated-values). The
 * VALUE side (RHS) is the canonical DocumentMimeEnum member the
 * BE signed against.
 */
const MIME_CANONICALIZATION = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'text/comma-separated-values': 'text/csv',
  // Note: `application/x-zip-compressed` (Windows browser alias for .zip)
  // is NOT mapped — `application/zip` is not in DocumentMimeEnum (only
  // xlsx/docx with their canonical `vnd.openxmlformats-…` MIMEs are
  // allow-listed). Mapping it would silently coerce a rejected upload
  // to a rejected upload via a different code path.
} as const satisfies Record<string, DocumentMime>;

/** Public — call BOTH in the upload hook (before createDocument) AND
 *  by uploadToPresigned (defense in depth). */
export function canonicalMime(raw: string): string {
  return (MIME_CANONICALIZATION as Record<string, string>)[raw] ?? raw;
}

export async function uploadToPresigned(url: string, blob: Blob, mimeType: string): Promise<void> {
  const canonical = canonicalMime(mimeType);
  const res = await fetch(url, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': canonical },
    // §v9-post-audit-CRITICAL — presigned URLs are signature-bound;
    // sending cookies / Authorization to R2 would (a) corrupt the
    // signature on some configurations, and (b) leak a bearer token
    // if the URL is ever attacker-controlled (cache poisoning, XSS).
    // `credentials: 'omit'` is the only safe default here.
    credentials: 'omit',
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
