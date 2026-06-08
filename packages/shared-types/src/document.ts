import { z } from 'zod';

import { HttpOrHttpsUrlSchema, HttpsUrlSchema } from './safe-url';

// Canonical Document contract (Doc 11 SoT; Phase 4 Slice D1).
//
// Locked-schema alignment: the `documents` table (Phase 1, Gate-2) has
// columns org_id, project_id?, apartment_id?, name, type, mime_type,
// size_bytes, r2_key, content_hash, uploaded_by, archived_at.
//
// SECURITY (information-confidentiality, user-mandated):
//  - `r2_key` (the storage pointer) is NEVER exposed on the wire. The
//    response schema below deliberately omits it; clients only ever get
//    a short-lived presigned URL, minted server-side AFTER authorization.
//  - `mimeType` is an ALLOW-LIST (fail-closed). SVG/HTML are excluded —
//    they are stored-XSS vectors; download is also forced to attachment.
//  - `sizeBytes` is hard-bounded here (defense-in-depth) and again at the
//    presigned-PUT content-length-range.
//  - `type` is FREE TEXT on the `documents` table (no DB enum). Seeds, imports
//    and migrations write the REAL urban-renewal types (`agreement` /
//    `blueprint` / `regulation`). The READ schema below therefore parses `type`
//    as a tolerant string — it MUST NEVER throw on an unrecognised value, or the
//    whole list `.parse` fails and the documents surface (and the signature
//    document-picker) silently break (the DV-MGR-DOCS ship-blocker). The
//    `DocumentTypeEnum` below is the CURATED set the UI offers on upload + the
//    canonical label keys — NOT a wire validator for reads.

export const DocumentTypeEnum = z.enum([
  // REAL urban-renewal types the BE seeds/imports use (these were the
  // DV-MGR-DOCS gap — the FE enum didn't include them):
  'agreement', // הסכם — the core urban-renewal signed doc
  'blueprint', // תוכנית / שרטוט
  'regulation', // תקנון / רגולציה
  // legacy generic types (kept for back-compat with existing data + uploads):
  'contract',
  'permit',
  'id_document',
  'floor_plan',
  'financial',
  'other',
]);
export type DocumentType = z.infer<typeof DocumentTypeEnum>;

/** Allow-listed upload MIME types. Executables, text/html and
 * image/svg+xml are intentionally excluded (active-content / XSS). */
export const DocumentMimeEnum = z.enum([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword', // doc
  'text/plain',
]);
export type DocumentMime = z.infer<typeof DocumentMimeEnum>;

/** 50 MB hard ceiling (defense-in-depth; also enforced at the presign). */
export const DOCUMENT_MAX_SIZE_BYTES = 52_428_800;

/**
 * Error-envelope `code` (D.16) for a document whose upload never finalised —
 * a "ghost" row (tab closed mid-upload, transient error, or the 5-min presign
 * expired). The download/preview path returns this DISTINCT code (HTTP 409)
 * INSTEAD of the generic `not_found`, so the FE can show the OWNER an
 * actionable "your upload didn't finish — re-upload" message.
 *
 * Single source of truth: the BE throws with this code, the FE switches on it.
 * It is ONLY ever emitted for a document already authorised as visible to the
 * caller — a foreign/unknown id still returns the generic `not_found`, so this
 * code is never an existence oracle.
 */
export const DOCUMENT_UPLOAD_INCOMPLETE_CODE = 'document_upload_incomplete' as const;

/** Wire representation — NEVER includes r2Key. */
export const DocumentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  apartmentId: z.string().uuid().nullable(),
  name: z.string().min(1).max(255),
  // TOLERANT (free-text on the BE): the READ schema must parse ANY stored type
  // (seeds/imports use agreement/blueprint/regulation; future imports may use
  // others). Never an enum here — a single bad row must not break the whole
  // list `.parse` (DV-MGR-DOCS). The FE label-map handles known types + falls
  // back for the rest. Upload/patch still validate against `DocumentTypeEnum`.
  type: z.string().min(1).max(64),
  mimeType: DocumentMimeEnum,
  sizeBytes: z.number().int().min(0).max(DOCUMENT_MAX_SIZE_BYTES),
  contentHash: z.string().min(1).max(128),
  uploadedBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Document = z.infer<typeof DocumentSchema>;

// Optional parent linkage comes in the BODY (a document may hang off a
// project, an apartment, or be org-level) — each is server-validated as
// visible to the caller (no-oracle 404), never trusted from the client.
const documentWriteShape = {
  name: z.string().min(1).max(255),
  type: DocumentTypeEnum,
  mimeType: DocumentMimeEnum,
  sizeBytes: z.number().int().min(1).max(DOCUMENT_MAX_SIZE_BYTES),
  contentHash: z.string().min(1).max(128),
  projectId: z.string().uuid().nullable().optional(),
  apartmentId: z.string().uuid().nullable().optional(),
} as const;

/** POST /documents — declares metadata; server generates the key and
 * returns a presigned PUT. Client never supplies the storage key. */
export const CreateDocumentInput = z.object(documentWriteShape).strict();
export type CreateDocument = z.infer<typeof CreateDocumentInput>;

/** PATCH /documents/:id — rename / re-categorise only. Storage pointer,
 * hash, size and parent are immutable post-create (integrity). */
export const UpdateDocumentInput = z
  .object({
    name: z.string().min(1).max(255).optional(),
    type: DocumentTypeEnum.optional(),
  })
  .strict();
export type UpdateDocument = z.infer<typeof UpdateDocumentInput>;

/** POST /documents/:id/finalize — verify the uploaded object matches the
 * declared size/hash; mismatch → the document is archived + purged. */
export const FinalizeDocumentInput = z
  .object({
    sizeBytes: z.number().int().min(1).max(DOCUMENT_MAX_SIZE_BYTES),
    contentHash: z.string().min(1).max(128),
  })
  .strict();
export type FinalizeDocument = z.infer<typeof FinalizeDocumentInput>;

/** GET /documents — keyset pagination only (D.16; never offset), with
 * optional parent scoping. */
export const ListDocumentsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
    projectId: z.string().uuid().optional(),
    apartmentId: z.string().uuid().optional(),
  })
  .strict();
export type ListDocumentsQueryDto = z.infer<typeof ListDocumentsQuery>;

/** POST /documents response — the document + a short-lived presigned PUT.
 * `uploadUrl` is a bearer credential: never logged, short TTL.
 *
 * §RED-1 closure — `HttpOrHttpsUrlSchema` instead of `z.string().url()`.
 * The default Zod url() accepts ANY scheme including `javascript:` and
 * `data:`, which is an XSS vector when the URL hits `<a href>` or
 * `window.open`. We pin to http/https only; the BE always produces
 * https for R2 in prod, but http is allowed for offline/mock dev. */
export const DocumentUploadResponseSchema = z.object({
  document: DocumentSchema,
  uploadUrl: HttpOrHttpsUrlSchema,
  uploadExpiresInSeconds: z.number().int().positive(),
});
export type DocumentUploadResponse = z.infer<typeof DocumentUploadResponseSchema>;

/** GET /documents/:id/download response — a short-lived presigned GET.
 * Minted ONLY after the row is authorized for the caller.
 *
 * §RED-1 — `HttpsUrlSchema` (stricter than upload URL because download
 * URLs reach `window.open` directly; we require https in all envs). */
export const DocumentDownloadResponseSchema = z.object({
  url: HttpsUrlSchema,
  expiresInSeconds: z.number().int().positive(),
});
export type DocumentDownloadResponse = z.infer<typeof DocumentDownloadResponseSchema>;
