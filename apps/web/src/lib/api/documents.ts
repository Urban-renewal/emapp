/**
 * Documents API client (D.28).
 *
 * Confidentiality posture:
 *  - r2_key is NEVER on the wire — the FE never receives a key. POST
 *    /documents returns `{ document, uploadUrl, uploadExpiresInSeconds }`
 *    where uploadUrl is a short-lived presigned PUT (5 min).
 *  - 7d: SENSITIVE docs (id_document/financial, or sensitive:true) get
 *    `uploadUrl: null` + `contentUploadPath` instead — their bytes go
 *    through POST /documents/:id/content (raw octet-stream) so the server
 *    can integrity-check, AV-scan and envelope-encrypt the plaintext. The
 *    content route stamps uploaded itself: NO finalize on that leg.
 *  - GET /documents/:id/download is dual-mode (7d): plain docs answer the
 *    `{ url, expiresInSeconds }` presign JSON (2 min); bytes_encrypted
 *    docs are decrypt-STREAMED by the API (a presigned URL would serve
 *    ciphertext) — see fetchDownload.
 *  - Finalize verifies size+hash; mismatch → server archives + purges.
 *  - MIME is an allow-list (enforced by shared-types DocumentMimeEnum).
 *  - 50 MB hard ceiling (also pre-checked client-side in uploadDocumentFlow).
 */
import {
  BoardCompletenessSchema,
  DOCUMENT_MAX_SIZE_BYTES,
  DocumentDownloadResponseSchema,
  DocumentSchema,
  DocumentUploadResponseSchema,
  type BoardCompleteness,
  type CreateDocument,
  type Document,
  type DocumentMime,
  type DocumentParty,
  type DocumentType,
  type DocumentUploadResponse,
  type FinalizeDocument,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, apiFetchRaw, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const DocumentDataSchema = z.object({ data: DocumentSchema });
const UploadResponseDataSchema = z.object({ data: DocumentUploadResponseSchema });
const DownloadResponseDataSchema = z.object({ data: DocumentDownloadResponseSchema });
// D.16 error envelope — parsed off raw (non-apiClient) responses (7d byte
// paths) so error codes/details surface as the same ApiClientError shape.
const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export interface DocumentListPage {
  items: Document[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listDocuments(
  query: {
    limit?: number;
    cursor?: string;
    projectId?: string;
    apartmentId?: string;
    archived?: boolean;
  } = {},
): Promise<DocumentListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.apartmentId) params.set('apartmentId', query.apartmentId);
  // Only send when true — the BE defaults to the active view.
  if (query.archived) params.set('archived', 'true');
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/documents${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(DocumentSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

/**
 * NS1 server-side document search (Phase 1) — GET /documents/search. The board
 * + the search box hit the REAL endpoint (not a filter over one loaded page —
 * the bug this fixes). `q` is required (the search verb); `type`/`party`/`scope`/
 * `archived` are optional NARROWING filters (each only restricts, never widens).
 * PII posture: `q` is a document NAME substring (an org-internal label), never
 * national_id/phone — same GET-search shape the projects list already uses
 * (Doc 07 §7.10 bans PII in query params; a doc name is not PII). The response
 * is the SAME `{ items, page }` shape as `listDocuments`, defensively Zod-parsed
 * (ARCHITECTURE-MAP §1; r2Key never on the wire).
 */
export interface DocumentSearchArgs {
  q: string;
  limit?: number;
  cursor?: string;
  type?: DocumentType;
  /** Binder party (board zoom-in) — narrows to that party's doc types server-side. */
  party?: DocumentParty;
  scope?: 'project' | 'apartment' | 'org';
  archived?: boolean;
}

export async function searchDocuments(args: DocumentSearchArgs): Promise<DocumentListPage> {
  const params = new URLSearchParams();
  params.set('q', args.q);
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  if (args.cursor) params.set('cursor', args.cursor);
  if (args.type) params.set('type', args.type);
  if (args.party) params.set('party', args.party);
  if (args.scope) params.set('scope', args.scope);
  // Only send when true — the BE defaults to the active (non-archived) view.
  if (args.archived) params.set('archived', 'true');
  const res = await apiClient.getList<unknown>(`/documents/search?${params.toString()}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(DocumentSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

const BoardCompletenessDataSchema = z.object({ data: BoardCompletenessSchema });

/** GET /documents/board-completeness — per-PARTY required-vs-received over the
 *  WHOLE board scope, computed server-side (the FE can't: the board is keyset-
 *  paginated). Defensive Zod parse like every other wrapper (ARCHITECTURE-MAP
 *  §1). Counts + doc-type keys only — no PII on the wire. */
export async function getBoardCompleteness(): Promise<BoardCompleteness> {
  const res = await apiClient.get<unknown>(`/documents/board-completeness`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return BoardCompletenessDataSchema.parse({ data: res.data }).data;
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

/** 7d — which leg the freshly-created document's bytes take. */
export type UploadPlan =
  | { mode: 'presigned'; uploadUrl: string }
  | { mode: 'content'; contentUploadPath: string };

/** The /api/v1 prefix apiFetchRaw prepends — the BE's `contentUploadPath`
 *  arrives WITH it (`/api/v1/documents/<id>/content`), so we validate the
 *  full path and strip the prefix before handing it to the client. */
const API_V1_PREFIX = '/api/v1';
// Tight shape allow-list — RELATIVE, exactly the content route for ONE
// document id. An absolute URL (or any other path) coming back in
// `contentUploadPath` would otherwise let a compromised/buggy response
// redirect the raw PII bytes (+ cookies, same-origin) to an arbitrary
// endpoint. Fail closed on anything that isn't the known route.
const CONTENT_UPLOAD_PATH_RE =
  /^\/api\/v1\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/i;

/**
 * 7d branch decision (pure — pinned by documents-content-path.spec.ts):
 *  - `uploadUrl` present → the presigned-PUT leg, UNCHANGED from pre-7d.
 *  - `uploadUrl: null` + a valid relative `contentUploadPath` → the
 *    sensitive-doc API content leg (raw bytes via POST, NO finalize —
 *    the content route stamps `uploaded` itself; finalize would 409
 *    `document_already_uploaded`).
 *  - anything else (null + missing/malformed path) → fail closed.
 */
export function resolveUploadPlan(
  created: Pick<DocumentUploadResponse, 'uploadUrl' | 'contentUploadPath'>,
): UploadPlan {
  if (created.uploadUrl) return { mode: 'presigned', uploadUrl: created.uploadUrl };
  const path = created.contentUploadPath;
  if (typeof path === 'string' && CONTENT_UPLOAD_PATH_RE.test(path)) {
    return { mode: 'content', contentUploadPath: path };
  }
  throw new ApiClientError({
    code: 'invalid_response',
    message: 'create returned neither a presigned uploadUrl nor a valid contentUploadPath',
  });
}

/**
 * 7d — POST the raw bytes of a SENSITIVE document to the API content path
 * (`application/octet-stream`, same-origin credentials like every API call —
 * the route is auth-guarded; unlike a presigned URL the path carries no
 * secret). On 200 the server has already integrity-checked (size+sha256
 * against the create-declared values), AV-scanned and envelope-encrypted
 * the plaintext AND stamped the row uploaded — the caller must NOT finalize.
 * Errors surface the envelope code/details (`document_integrity_mismatch`
 * + details.field, `document_scan_rejected`, `storage_unavailable`, …).
 */
export async function uploadDocumentContent(contentUploadPath: string, blob: Blob): Promise<void> {
  if (!CONTENT_UPLOAD_PATH_RE.test(contentUploadPath)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'bad contentUploadPath' });
  }
  // timeoutMs: 0 — a 50MB body can exceed the 15s default; same posture as
  // uploadToPresigned (which has no timeout at all).
  const res = await apiFetchRaw(contentUploadPath.slice(API_V1_PREFIX.length), {
    method: 'POST',
    body: blob,
    headers: { 'Content-Type': 'application/octet-stream' },
    timeoutMs: 0,
  });
  if (res.ok) return;
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // non-JSON failure body — fall through to the generic code.
  }
  const env = ErrorEnvelopeSchema.safeParse(parsed);
  if (env.success) throw new ApiClientError(env.data.error);
  throw new ApiClientError({
    code: 'upload_failed',
    message: `content upload returned ${res.status}`,
  });
}

export interface UploadDocumentArgs {
  file: File;
  type: DocumentType;
  mimeType: DocumentMime;
  projectId?: string | null;
  apartmentId?: string | null;
}

/**
 * The full upload orchestration (extracted from useUploadDocument so the
 * 7d branch decision is seam-testable without React):
 *   create → resolveUploadPlan →
 *     presigned: PUT to R2 → finalize          (pre-7d flow, UNCHANGED)
 *     content:   POST bytes to the API → DONE   (no finalize — it would 409)
 * Client-side 50MB ceiling enforced BEFORE any network/hashing so an
 * oversized pick fails fast with an actionable code.
 */
export async function uploadDocumentFlow(args: UploadDocumentArgs): Promise<Document> {
  if (args.file.size > DOCUMENT_MAX_SIZE_BYTES) {
    throw new ApiClientError({
      code: 'document_too_large',
      message: `file exceeds the ${DOCUMENT_MAX_SIZE_BYTES}-byte ceiling`,
    });
  }
  const contentHash = await sha256OfBlob(args.file);
  // §v9-M-3 — canonicalize the mime ONCE so the signed Content-Type at
  // create-time matches what we PUT to R2.
  const mimeType = canonicalMime(args.mimeType) as DocumentMime;
  const created = await createDocument({
    name: args.file.name,
    type: args.type,
    mimeType,
    sizeBytes: args.file.size,
    contentHash,
    projectId: args.projectId ?? null,
    apartmentId: args.apartmentId ?? null,
  });
  const plan = resolveUploadPlan(created);
  if (plan.mode === 'content') {
    // 7d sensitive leg — the content route verifies/scans/encrypts and
    // stamps `uploaded` itself; finalize after it would 409.
    await uploadDocumentContent(plan.contentUploadPath, args.file);
    return created.document;
  }
  // B7 — the presigned PUT is create-only + checksum-bound (the BE signs
  // `If-None-Match: *` and `x-amz-checksum-sha256` into the URL). The PUT MUST
  // therefore SEND those exact headers or R2 rejects (412 / SignatureDoesNotMatch).
  // `contentHash` is the lowercase-hex sha256 we computed above AND declared at
  // create — convert it to the base64-of-raw-digest the S3 checksum header wants
  // so the bound checksum and the sent checksum are the same value.
  await uploadToPresigned(plan.uploadUrl, args.file, mimeType, {
    createOnly: true,
    contentSha256Base64: hexSha256ToBase64(contentHash),
  });
  return finalizeDocument(created.document.id, {
    sizeBytes: args.file.size,
    contentHash,
  });
}

/** Narrow the BE's `document_integrity_mismatch` `details` to the offending
 *  field so callers can render the actionable copy ("size" → גודל /
 *  "hash" → תוכן). Shared by /documents/new + ProjectDocumentUpload. */
export function integrityMismatchField(details: unknown): 'size' | 'hash' | null {
  if (details && typeof details === 'object' && 'field' in details) {
    const f = (details as { field?: unknown }).field;
    if (f === 'size' || f === 'hash') return f;
  }
  return null;
}

/** POST /documents/:id/finalize — confirm the upload matched the
 *  declared size + hash. Server cross-checks with R2 metadata. */
export async function finalizeDocument(id: string, body: FinalizeDocument): Promise<Document> {
  const res = await apiClient.post<unknown>(`/documents/${id}/finalize`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DocumentDataSchema.parse({ data: res.data }).data;
}

/** What a download click resolved to (7d dual-mode contract):
 *  - `presign` — the plain-doc branch: a short-lived presigned GET URL the
 *    FE opens in a new tab (byte-identical to the pre-7d behaviour).
 *  - `bytes` — the sensitive-doc branch: the API decrypt-STREAMED the
 *    object itself (a presigned URL would serve ciphertext); the FE turns
 *    the Blob into an object URL and opens/saves per the disposition. */
export type DocumentDownloadResult =
  | { kind: 'presign'; url: string; expiresInSeconds: number }
  | { kind: 'bytes'; blob: Blob; filename: string | null };

/** Strict `application/json` content-type check — anything else on the
 *  download wire is the document byte stream. Exported for the seam spec. */
export function isJsonContentType(contentType: string | null): boolean {
  return /^application\/json\b/i.test((contentType ?? '').trim());
}

/** GET /documents/:id/download — dual-mode (7d).
 *  JSON response → the existing `{ data: { url, expiresInSeconds } }`
 *  presign contract (plain docs). Non-JSON response (content-type is the
 *  doc mime / octet-stream) → the decrypt-streamed bytes of a SENSITIVE
 *  doc; returned as a Blob + the server-stamped filename.
 *  `disposition`: `attachment` (default) → save dialog; `inline` → renders
 *  in-tab. All BE gates (403 `pii_step_up_required` → the step-up modal,
 *  ghost/scan 409s) arrive as JSON error envelopes and throw
 *  ApiClientError exactly like before. Never log the URL. */
export async function fetchDownload(
  id: string,
  disposition: 'inline' | 'attachment' = 'attachment',
): Promise<DocumentDownloadResult> {
  const qs = disposition === 'inline' ? '?disposition=inline' : '';
  // timeoutMs: 0 — a 50MB decrypt-stream can legitimately exceed the 15s
  // default; same no-timeout posture as the presigned PUT upload.
  const res = await apiFetchRaw(`/documents/${id}/download${qs}`, {
    method: 'GET',
    timeoutMs: 0,
  });
  if (isJsonContentType(res.headers.get('content-type'))) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiClientError({ code: 'invalid_response' });
    }
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      throw new ApiClientError(ErrorEnvelopeSchema.parse(parsed).error);
    }
    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
      const { url, expiresInSeconds } = DownloadResponseDataSchema.parse(parsed).data;
      return { kind: 'presign', url, expiresInSeconds };
    }
    throw new ApiClientError({ code: 'invalid_response' });
  }
  if (!res.ok) {
    // Non-JSON failure (proxy hiccup etc.) — no envelope to surface.
    throw new ApiClientError({
      code: 'download_failed',
      message: `download returned ${res.status}`,
    });
  }
  const blob = await res.blob();
  return {
    kind: 'bytes',
    blob,
    filename: parseDispositionFilename(res.headers.get('content-disposition')),
  };
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

/** B7 anti-overwrite/anti-tamper headers the presigned PUT must carry. The BE
 *  signs these INTO the URL (`signableHeaders`), so the PUT must send the same
 *  values or R2 rejects (412 PreconditionFailed / SignatureDoesNotMatch /
 *  BadDigest). Omitted ⇒ legacy URL with no header binding. */
export interface PresignedPutGuards {
  /** Sends `If-None-Match: '*'` so R2 refuses a PUT to an already-stored key
   *  (single-shot upload; a leaked URL can't overwrite — anti-דריסה). */
  createOnly?: boolean;
  /** base64 of the RAW sha256 digest (NOT hex). Sent as `x-amz-checksum-sha256`
   *  so R2 verifies the uploaded bytes hash to the create-declared value. */
  contentSha256Base64?: string;
}

export async function uploadToPresigned(
  url: string,
  blob: Blob,
  mimeType: string,
  guards: PresignedPutGuards = {},
): Promise<void> {
  const canonical = canonicalMime(mimeType);
  const headers: Record<string, string> = { 'Content-Type': canonical };
  // B7 — the presigned URL SIGNS these headers, so they must be present on the
  // wire for R2 to accept the PUT and enforce create-only + checksum binding.
  if (guards.createOnly) headers['If-None-Match'] = '*';
  if (guards.contentSha256Base64) headers['x-amz-checksum-sha256'] = guards.contentSha256Base64;
  const res = await fetch(url, {
    method: 'PUT',
    body: blob,
    headers,
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

/**
 * RFC 6266 `filename=` / `filename*=` parsing for the 7d byte-stream
 * download — same narrow parser as ExportXlsxButton's (kept here because
 * lib/api must not import from app/ components). Prefers `filename*=`
 * (RFC 5987 UTF-8) so Hebrew document names survive; the BE-stamped
 * header is the authoritative filename source (never the display name —
 * PII / U+202E spoof rationale, see export-xlsx-button.tsx).
 * Exported for the seam spec.
 */
export function parseDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const rfc5987 = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (rfc5987 && rfc5987[1]) {
    try {
      return decodeURIComponent(rfc5987[1].trim());
    } catch {
      // fall through to plain filename=
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
  if (plain) {
    return (plain[2] ?? plain[3] ?? '').trim() || null;
  }
  return null;
}

/** B7 — convert a lowercase-hex sha256 digest into the base64-of-RAW-digest
 *  string the S3/R2 `x-amz-checksum-sha256` header expects. The BE binds the
 *  SAME conversion into the presigned URL (Buffer.from(hex,'hex').toString('base64')),
 *  so the sent checksum and the signed checksum match. A non-canonical / wrong-
 *  length hash returns '' (no valid 32-byte digest) — degrades to a checksum-less
 *  header, mirroring the BE's safe-degrade; finalize's storage-attested gate
 *  still catches any real mismatch fail-closed. */
export function hexSha256ToBase64(hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return '';
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Compute SHA-256 of a Blob — used as the document content hash. */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
