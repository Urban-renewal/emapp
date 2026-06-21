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
  'land_registry', // נסח טאבו — carries EVERY owner's national_id → ALWAYS sensitive
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

/**
 * Error-envelope `code` (D.16) for a document whose anti-malware scan did NOT
 * return `clean` — the uploaded object was flagged `infected`, or the scan
 * could not complete (`error`). The download path is FAIL-CLOSED: anything
 * that is not a `clean` verdict is never servable (P0.B1). The finalize path
 * returns this DISTINCT code (HTTP 409) so the FE can tell the owner the file
 * was rejected by malware scanning rather than showing a generic conflict.
 *
 * Only ever emitted for a document already authorised as visible to the caller
 * (same no-oracle posture as `DOCUMENT_UPLOAD_INCOMPLETE_CODE`).
 */
export const DOCUMENT_SCAN_REJECTED_CODE = 'document_scan_rejected' as const;

/**
 * Error-envelope `code` (D.16) for a document whose REAL leading bytes do not
 * match its declared `mimeType` — type spoofing (or an honest accident, e.g. a
 * `.docx` uploaded as `application/pdf`). Defense-in-depth alongside the AV
 * scan (SECURITY-UPLOAD-AUDIT.md threat #3): the server sniffs the magic bytes
 * it already holds (the scan gate / sensitive content path) and FAIL-CLOSED
 * rejects a mismatch with the same archive+purge posture as an infected file —
 * the object is never stored/served. 409 (the object exists but is in a state
 * that conflicts with serving it), only ever reachable AFTER the per-record
 * visibility check, so it is never an existence oracle.
 */
export const DOCUMENT_TYPE_MISMATCH_CODE = 'document_type_mismatch' as const;

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
  /** 7b-OTP (D-P5.7) — explicit client opt-IN to the sensitive-document gate.
   * TURN-ON ONLY: the server derives sensitive=true for PII-bearing types
   * (id_document / financial) regardless; `sensitive:false` can NEVER force a
   * sensitive-by-type doc off the gate. Absent → by-type derivation alone. */
  sensitive: z.boolean().optional(),
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
    /**
     * `'true'` returns ARCHIVED documents (the default view filters them out, so
     * archived docs would otherwise be invisible in the cockpit). Explicit
     * 'true'|'false' enum — NOT z.coerce.boolean (which coerces the *string*
     * 'false' to `true`). Inferred type is boolean.
     */
    archived: z
      .enum(['true', 'false'])
      .optional()
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
export type ListDocumentsQueryDto = z.infer<typeof ListDocumentsQuery>;

/**
 * NS1 (server-side search, MASTER-PLAN-V13 Wave B) — the documents-search
 * `scope` filter. Narrows by the document's PARENT linkage:
 *   - `project`   — docs attached directly to a project (project_id NOT NULL).
 *   - `apartment` — docs attached to an apartment (apartment_id NOT NULL).
 *   - `org`       — org-level docs (neither parent set).
 * Absent → no scope filter (all visible docs). This does NOT widen visibility:
 * the agent record-scoping + archived/scan/sensitive rules still apply on top.
 */
export const DocumentScopeEnum = z.enum(['project', 'apartment', 'org']);
export type DocumentScope = z.infer<typeof DocumentScopeEnum>;

/**
 * GET /documents/search — name substring search + type/scope filters, keyset-
 * paginated (D.16; never offset). `q` is required (the search verb). `type`
 * filters by the curated DocumentTypeEnum; `scope` by parent linkage. Respects
 * the SAME visibility rules as the list endpoint (agent record-scoping,
 * archived excluded by default, scan/sensitive gates on download unchanged) —
 * it never widens what a caller can see.
 */
export const DocumentSearchQuery = z
  .object({
    q: z.string().trim().min(1).max(255),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
    type: DocumentTypeEnum.optional(),
    scope: DocumentScopeEnum.optional(),
    /** `'true'` searches ARCHIVED docs too (default false — same posture as the
     *  list endpoint). Explicit enum (NOT z.coerce.boolean). */
    archived: z
      .enum(['true', 'false'])
      .optional()
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
export type DocumentSearchQueryDto = z.infer<typeof DocumentSearchQuery>;

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
  /** 7d (D-P5.4 second half): SENSITIVE docs get NO presigned PUT — their
   *  bytes must flow through the API content path so the server can verify,
   *  scan and app-envelope-encrypt the plaintext. `null` for sensitive docs;
   *  plain docs keep the presigned PUT unchanged. */
  uploadUrl: HttpOrHttpsUrlSchema.nullable(),
  uploadExpiresInSeconds: z.number().int().positive().nullable(),
  /** 7d — present ONLY for sensitive docs: the API path the client must POST
   *  the raw bytes to (`/api/v1/documents/<id>/content`, raw body,
   *  application/octet-stream, 50MB ceiling). */
  contentUploadPath: z.string().optional(),
});
export type DocumentUploadResponse = z.infer<typeof DocumentUploadResponseSchema>;

/**
 * Content-Disposition for the download presigned URL.
 *  - `attachment` (default): forces a save dialog — the existing,
 *    unchanged behaviour. Safe for any allow-listed type.
 *  - `inline`: lets the browser RENDER the object in a tab (PDF preview,
 *    image view). Only ever applied to a `clean`-scanned, allow-listed
 *    object — SVG/HTML are excluded from the upload allow-list, so inline
 *    can never serve active content.
 */
export const DocumentDispositionEnum = z.enum(['attachment', 'inline']);
export type DocumentDisposition = z.infer<typeof DocumentDispositionEnum>;

/** GET /documents/:id/download query — optional `disposition`. Defaults to
 * `attachment` so existing callers are byte-for-byte unchanged. */
export const DownloadDocumentQuery = z
  .object({
    disposition: DocumentDispositionEnum.default('attachment'),
  })
  .strict();
export type DownloadDocumentQueryDto = z.infer<typeof DownloadDocumentQuery>;

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

// ── DH2 (V13) — project document-CHECKLIST (ADVISORY only) ──────────────────
// `GET /api/v1/projects/:id/document-checklist` reports, per the project's
// renewal TRACK (derived from `projects.type`), the REQUIRED document types and
// whether each is present — a doc of that `type` exists, scoped to the project
// (doc_scope='project', doc_scope_id=project.id, non-archived), OR (back-compat)
// the legacy `project_id` column points at the project. Auto-ticked, read-only.
//
// ADVISORY ONLY (V13 Open #2): this endpoint NEVER gates or mutates project
// status — it only reports. No writes. The "→ approved" gate-wiring is a deferred
// one-flag flip after counsel signs the templates.
//
// `track` is the human-facing track key the required-set was chosen FOR. It is
// NOT the raw `project_type` enum 1:1 — `tama38_1`/`tama38_2` collapse to the one
// 'tama38' checklist; `other` falls back to a sensible baseline (see the BE
// REQUIRED_DOC_TYPES_BY_TRACK constant). `items[].type` values are drawn from the
// curated `DocumentTypeEnum` above.

/** The renewal-track key a checklist required-set is defined for. */
export const DocumentChecklistTrackEnum = z.enum(['tama38', 'pinui_binui', 'default']);
export type DocumentChecklistTrack = z.infer<typeof DocumentChecklistTrackEnum>;

/** One required doc TYPE and whether a matching project-scoped doc exists. NO
 *  PII, NO document ids/names — purely the type key + the present boolean. */
export const DocumentChecklistItemSchema = z.object({
  /** A curated document type key (label resolution is the FE's job). */
  type: DocumentTypeEnum,
  present: z.boolean(),
});
export type DocumentChecklistItem = z.infer<typeof DocumentChecklistItemSchema>;

/** GET /api/v1/projects/:id/document-checklist response payload (under `data`).
 *  `completionPct` = round(presentCount / totalCount * 100), 0 when the track
 *  has no required types (defensive — every track today has >=1). ADVISORY:
 *  carries no status field and never reflects a gate decision. */
export const DocumentChecklistSchema = z.object({
  projectId: z.string().uuid(),
  /** The raw project type the track was derived from (audit/debug aid). */
  projectType: z.string(),
  track: DocumentChecklistTrackEnum,
  items: z.array(DocumentChecklistItemSchema),
  presentCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  completionPct: z.number().int().min(0).max(100),
  /** Always true — pins the ADVISORY contract so a future gating variant is a
   *  DISTINCT shape, not a silent behavior change on this one. */
  advisory: z.literal(true),
});
export type DocumentChecklist = z.infer<typeof DocumentChecklistSchema>;

// ── DH3 (V13) — heuristic document-type CLASSIFIER (SUGGEST-ONLY) ────────────
// `POST /api/v1/documents/classify` returns a RANKED list of suggested
// `doc_type` values for a document the user is about to upload (or re-type),
// from the curated `DocumentTypeEnum`, each with a confidence + the signal that
// matched. It is PURELY ADVISORY: it NEVER writes/mutates a document's type —
// the human confirms separately (the same "mandatory human confirm" doctrine as
// D.18 / the tabu auto-parse, MASTER-PLAN-V13 DH3 "suggest-never-auto-commit").
//
// The classifier reads only the inputs the FE already holds for a picked file:
//   - `filename`    — the original name (Hebrew or latin); regex signals.
//   - `mimeType`    — the declared MIME (allow-listed `DocumentMimeEnum`).
//   - `sampleBase64`— OPTIONAL, the FIRST bytes of the file (base64). Used for a
//                     magic-byte sniff and a cheap first-page text scan for
//                     marker phrases (e.g. נסח/טאבו ⇒ land_registry). HARD-CAPPED
//                     small (leading bytes are all the heuristics need) so a
//                     caller can never push large payloads through this advisory
//                     path. The raw bytes are NEVER logged and never stored.

/** Max RAW sample size (bytes) the classifier inspects — leading bytes only.
 *  8 KiB comfortably covers every magic signature + a first-page text peek;
 *  anything larger is irrelevant to the heuristics and a needless payload. */
export const CLASSIFY_SAMPLE_MAX_BYTES = 8_192;
/** Max base64 STRING length for `sampleBase64` (defense-in-depth at the Zod
 *  boundary, before any decode). base64 is 4 chars per 3 bytes; round up and
 *  add slack for padding/whitespace. The service re-checks the DECODED length
 *  against CLASSIFY_SAMPLE_MAX_BYTES (the authoritative cap). */
export const CLASSIFY_SAMPLE_MAX_BASE64_CHARS = 12_000;

/** POST /documents/classify request — the signals about a to-be-uploaded file.
 *  `mimeType` is the same allow-list as upload (fail-closed; no html/svg). */
export const ClassifyDocumentInput = z
  .object({
    filename: z.string().trim().min(1).max(255),
    mimeType: DocumentMimeEnum,
    /** OPTIONAL leading-bytes sample (base64). Bounded here AND re-checked
     *  post-decode against CLASSIFY_SAMPLE_MAX_BYTES in the service. */
    sampleBase64: z.string().max(CLASSIFY_SAMPLE_MAX_BASE64_CHARS).optional(),
  })
  .strict();
export type ClassifyDocument = z.infer<typeof ClassifyDocumentInput>;

/** The signal family that produced a suggestion — lets the FE render a reason
 *  ("matched filename" vs "content marker") and lets tests pin WHY a type won. */
export const ClassifySignalEnum = z.enum(['filename', 'mime', 'magic_byte', 'content_text']);
export type ClassifySignal = z.infer<typeof ClassifySignalEnum>;

/** One ranked suggestion. `confidence` is 0..1 (higher = stronger). `reason`
 *  is a short, content-free, stable key the FE maps to a localized string —
 *  NEVER raw filename/bytes (no PII echo). */
export const ClassifySuggestionSchema = z.object({
  docType: DocumentTypeEnum,
  confidence: z.number().min(0).max(1),
  signal: ClassifySignalEnum,
  /** Stable, content-free reason key (e.g. 'filename_tabu', 'content_nesach',
   *  'mime_pdf'). Maps to a localized label on the FE; carries no user input. */
  reason: z.string().min(1).max(64),
});
export type ClassifySuggestion = z.infer<typeof ClassifySuggestionSchema>;

/** POST /documents/classify response payload (under `data`). `suggestions` is
 *  ranked DESC by confidence (best first); EMPTY when no signal fired (the FE
 *  then leaves the type unset for the human to choose). SUGGEST-ONLY — this
 *  response never reflects or implies a committed type. */
export const ClassifyResultSchema = z.object({
  suggestions: z.array(ClassifySuggestionSchema),
  /** Always true — pins the suggest-only contract so a future auto-apply
   *  variant must be a DISTINCT shape, not a silent behavior change. */
  suggestOnly: z.literal(true),
});
export type ClassifyResult = z.infer<typeof ClassifyResultSchema>;
