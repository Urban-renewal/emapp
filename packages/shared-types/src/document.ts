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
  // BINDER slice 3 (party-binder taxonomy adds) — the documents the OTHER deal
  // parties bring to a renewal file. Before these, such docs fell to "כללי /
  // אחר" on the binder board (no party bucket); they now classify + group under
  // their party (appraiser / surveyor / contractor / municipality / lawyer).
  // NO DB migration — `documents.type` is free text on the table; reads are
  // tolerant (DocumentSchema.type is z.string, not this enum). These are all
  // NON-sensitive: none are national_id-dense the way נסח/ID/financial are, so
  // none are added to SENSITIVE_DOC_TYPES (over-marking would push non-PII docs
  // through the at-rest-encryption + step-up gate needlessly).
  'survey', // שומה / הערכת שמאי — the appraiser's (שמאי) valuation
  'survey_map', // מפת מדידה / תשריט מדידה — the surveyor's (מודד) measurement map
  'guarantee', // ערבות / בטוחה — the contractor's (קבלן) bank/performance guarantee
  'municipal_approval', // היתר / אישור עירייה — the municipality's approval
  'schedule', // לוח זמנים / תכנית עבודה — the contractor's (קבלן) work schedule
  'legal_opinion', // חוות דעת משפטית — the lawyer's (עו״ד) legal opinion
  // S4-taxonomy (party-gap closure) — APPEND-ONLY. Two more deal-party docs that
  // had no curated type, so they fell to "כללי / אחר" on the binder board:
  //   • inspection_report — the מפקח's (supervisor) site/works inspection report.
  //     This is the ONLY type for the `supervisor` party (previously empty — the
  //     board showed a מפקח card with zero possible documents). NON-sensitive: a
  //     works report is not national_id-dense (kept OUT of SENSITIVE_DOC_TYPES).
  //   • power_of_attorney — ייפוי כוח. PII-DENSE: it authorises someone to act FOR
  //     an owner and carries the owner's national_id on its face, so unlike the
  //     other party docs it IS sensitive-by-type — added to SENSITIVE_DOC_TYPES
  //     below so it derives sensitive=true end-to-end (at-rest envelope + step-up
  //     gate). Maps → lawyer (עו״ד), the party that drafts/holds the POA.
  'inspection_report', // דו״ח פיקוח / דו״ח מפקח — the supervisor's (מפקח) report
  'power_of_attorney', // ייפוי כוח — PII-dense (national_id); → lawyer; SENSITIVE
  // legacy generic types (kept for back-compat with existing data + uploads):
  'contract',
  'permit',
  'id_document',
  'floor_plan',
  'financial',
  'other',
]);
export type DocumentType = z.infer<typeof DocumentTypeEnum>;

/**
 * PII-bearing document types that are SENSITIVE BY TYPE (D-P5.7) — the SINGLE
 * source of truth for "this type always derives sensitive=true". Surfaced HERE
 * (the FE/BE contract) so:
 *   - BE: `documents.service.ts` re-exports this set (it owns the create-time
 *     `sensitive = SENSITIVE_DOC_TYPES.has(type) || input.sensitive` derivation).
 *   - FE: the generic upload dropzone (S3) knows, WITHOUT a round-trip, which
 *     classifier suggestions / picked types must PAUSE for the encrypt notice and
 *     take the content-upload path — even at AUTO confidence a tabu/ID/financial
 *     is never silently auto-filed.
 *
 * TURN-ON ONLY: a type in this set ALWAYS derives sensitive=true; absence does
 * NOT force a doc non-sensitive (an explicit `sensitive:true` opt-in still wins).
 *   - id_document — תעודת זהות (national_id on its face).
 *   - financial   — financial statements / valuations carrying account data.
 *   - land_registry — נסח טאבו lists EVERY owner's national_id (PII-dense).
 *   - power_of_attorney — ייפוי כוח authorises acting FOR an owner and carries
 *     the owner's national_id on its face (S4-taxonomy); sensitive-by-type so it
 *     takes the at-rest-encryption content path + the step-up download gate.
 */
export const SENSITIVE_DOC_TYPES: ReadonlySet<DocumentType> = new Set<DocumentType>([
  'id_document',
  'financial',
  'land_registry',
  'power_of_attorney',
]);

/** True when a (tolerant, free-text) `type` is sensitive-by-type — same rule the
 *  BE applies at create. Pure + deterministic; case-insensitive trim to mirror
 *  {@link providerPartyForDocType}. Absence from the set is NOT "definitely
 *  non-sensitive" (an explicit opt-in can still force it on server-side). */
export function isSensitiveDocType(docType: string): boolean {
  return SENSITIVE_DOC_TYPES.has(docType.trim().toLowerCase() as DocumentType);
}

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

/**
 * Anti-malware scan verdict surfaced on the document READ shape (DOCUMENTS-
 * REMEDIATION-PLAN Phase 1). The BE owns EVERY write (default 'pending' at
 * create; 'clean' after the AV gate passes; 'infected'/'error' on a non-clean
 * verdict — those rows are also archived). TOLERANT parse (`.catch`) so a
 * future/unknown verdict value never throws the whole list `.parse` (the same
 * DV-MGR-DOCS posture as `type`): an unrecognised verdict degrades to
 * 'pending' (fail-safe: the FE shows "not yet servable", never a false
 * "clean"). NON-PII — purely a processing-state flag about the FILE.
 */
export const DocumentScanStatusEnum = z.enum(['pending', 'clean', 'infected', 'error']);
export type DocumentScanStatus = z.infer<typeof DocumentScanStatusEnum>;

// ── 2.6 future-states — the document legal/life-cycle enums (migration 0085).
// ALL nullable on the wire: NULL = not-yet-classified, which keeps the exact
// pre-2.6 semantics (the sharpened required-doc detection treats NULL as
// not-invalidating). PII-FREE taxonomy.
export const DocumentLegalStatusEnum = z.enum(['draft', 'reviewed', 'approved', 'rejected']);
export type DocumentLegalStatus = z.infer<typeof DocumentLegalStatusEnum>;
export const DocumentVersionStateEnum = z.enum(['current', 'superseded']);
export type DocumentVersionState = z.infer<typeof DocumentVersionStateEnum>;
export const DocumentNotaryStatusEnum = z.enum(['none', 'required', 'notarized']);
export type DocumentNotaryStatus = z.infer<typeof DocumentNotaryStatusEnum>;
export const DocumentRelevantPhaseEnum = z.enum([
  'planning',
  'signatures',
  'permit',
  'construction',
  'completion',
]);
export type DocumentRelevantPhase = z.infer<typeof DocumentRelevantPhaseEnum>;

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
  // ── DOCUMENTS-REMEDIATION-PLAN Phase 1 (foundation) — fields the detail card
  // already needs but the wire shape omitted (the near-blank-card bug). All
  // NON-PII:
  //   • `sensitive` — the PII-bearing-by-type / opt-in step-up flag (a structural
  //     fact about the FILE; drives the badge + the step-up download path). It is
  //     NOT owner PII — the boolean itself reveals nothing about any person.
  //   • `scanStatus` — the AV processing state (drives the scan indicator).
  //   • `projectName` / `apartmentName` — the RESOLVED parent LABELS (project
  //     name / apartment number) so the detail card can show + link the parent
  //     instead of a bare uuid. These are project/apartment labels, NEVER owner
  //     PII (national_id / phone / owner name). Nullable: org-level docs have no
  //     parent. `.optional()` because producers that do NOT join (the create /
  //     finalize / update responses, built from `toDocument` alone) omit them —
  //     only the get / list / search mappers LEFT JOIN to resolve them. A future
  //     reader must NOT treat their absence as "no parent" (that's `projectId ==
  //     null`); absence means "this producer didn't resolve the label".
  sensitive: z.boolean().default(false),
  scanStatus: DocumentScanStatusEnum.catch('pending').default('pending'),
  projectName: z.string().min(1).max(255).nullable().optional(),
  apartmentName: z.string().min(1).max(255).nullable().optional(),
  // ── 2.6 future-states — the document legal/life-cycle fields (migration
  // 0085). ALL nullable (NULL = not-yet-classified). `.catch(null)` on the
  // enums so a future/unknown stored value degrades to null instead of throwing
  // the whole list `.parse` (the same DV-MGR-DOCS posture as `type`/`scanStatus`).
  // PII-FREE — every field is taxonomy or a lifecycle timestamp about the FILE.
  legalStatus: DocumentLegalStatusEnum.nullable().catch(null).optional(),
  versionState: DocumentVersionStateEnum.nullable().catch(null).optional(),
  supersededByDocumentId: z.string().uuid().nullable().optional(),
  validUntil: z.coerce.date().nullable().optional(),
  notaryStatus: DocumentNotaryStatusEnum.nullable().catch(null).optional(),
  notarizedAt: z.coerce.date().nullable().optional(),
  relevantPhase: DocumentRelevantPhaseEnum.nullable().catch(null).optional(),
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

/** PATCH /documents/:id — rename / re-categorise + (2.6) set/clear the legal
 * life-cycle state fields. Storage pointer, hash, size and parent stay immutable
 * post-create (integrity).
 *
 * 2.6 future-states: every state field is `.nullable().optional()` — ABSENT
 * leaves the column untouched; an explicit `null` CLEARS it (back to
 * not-classified). The BE re-asserts the manager-tier `manage_documents` gate
 * (same as rename/retype). PII-FREE — all taxonomy / lifecycle timestamps. */
export const UpdateDocumentInput = z
  .object({
    name: z.string().min(1).max(255).optional(),
    type: DocumentTypeEnum.optional(),
    legalStatus: DocumentLegalStatusEnum.nullable().optional(),
    versionState: DocumentVersionStateEnum.nullable().optional(),
    supersededByDocumentId: z.string().uuid().nullable().optional(),
    validUntil: z.coerce.date().nullable().optional(),
    notaryStatus: DocumentNotaryStatusEnum.nullable().optional(),
    notarizedAt: z.coerce.date().nullable().optional(),
    relevantPhase: DocumentRelevantPhaseEnum.nullable().optional(),
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
 * The canonical PARTY tuple — the SINGLE source of truth for the binder
 * "who is responsible" axis. Declared HERE (above `DocumentSearchQuery`) so the
 * search `party` filter and the binder-board `DocumentPartyEnum` (built from
 * this tuple further down) can NEVER drift to two different party sets. Order is
 * the canonical board order.
 */
export const DOCUMENT_PARTY_VALUES = [
  'owner', // בעלים — land registry / id documents
  'appraiser', // שמאי — financial appraisal + שומה (survey)
  'architect', // אדריכל — blueprints / floor plans
  'municipality', // עירייה — permits + אישור/היתר עירייה (municipal_approval)
  'contractor', // קבלן — agreements / contracts + ערבות (guarantee) + לוח זמנים (schedule)
  'lawyer', // עו״ד — regulations / תקנון + חוות דעת משפטית + ייפוי כוח (power_of_attorney)
  'supervisor', // מפקח — דו״ח פיקוח (inspection_report)
  'surveyor', // מודד — מפת מדידה / תשריט (survey_map)
  'other', // כללי / אחר — neutral bucket + unknowns
] as const;

/**
 * GET /documents/search — name substring search + type/party/scope filters,
 * keyset-paginated (D.16; never offset). `q` is required (the search verb).
 * `type` filters by the curated DocumentTypeEnum (one exact type); `party`
 * (Phase 1 — board zoom-in) narrows to the doc types that roll up to that
 * binder party (the SAME providerPartyForDocType mapping the board uses), so
 * the FE can drill into a party's documents via the real server-side search
 * instead of filtering one loaded page; `scope` by parent linkage. Respects the
 * SAME visibility rules as the list endpoint (agent record-scoping, archived
 * excluded by default, scan/sensitive gates on download unchanged) — every
 * filter can only NARROW the result, never widen what a caller can see. If both
 * `type` and `party` are given, BOTH apply (AND) — `type` must also belong to
 * `party` or the result is empty (the service does not special-case this).
 */
export const DocumentSearchQuery = z
  .object({
    q: z.string().trim().min(1).max(255),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).optional(),
    type: DocumentTypeEnum.optional(),
    /** Phase 1 — narrow to a binder PARTY's doc types (board zoom-in). The
     *  service expands this to the type set via providerPartyForDocType; `other`
     *  additionally matches any UNMAPPED/unknown type (the board's catch-all
     *  bucket). Same value set as `DocumentPartyEnum` (one shared tuple). */
    party: z.enum(DOCUMENT_PARTY_VALUES).optional(),
    /** S2 (faceted shell) — narrow to ONE project. Matches a doc whose CANONICAL
     *  project (doc_scope='project' → doc_scope_id, else legacy project_id) is
     *  this id — the SAME resolver the board's received/required pass uses, so the
     *  facet count and the board agree. NARROWING only (never widens; the agent
     *  record-scoping + RLS still bound the result). A doc id, not PII. */
    projectId: z.string().uuid().optional(),
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

// ── DH4 (MASTER-PLAN-V13 Wave B) — document dedup probe ─────────────────────
// "link to existing, not duplicate": before a user uploads a file, the client
// hashes the bytes (the SAME sha256 hex it would declare at create/finalize —
// `content_hash`) and asks whether the org ALREADY holds an identical document.
// SUGGEST-ONLY / READ-ONLY: the probe returns link candidates so the FE can
// offer "קשר לקיים"; it NEVER creates a link nor mutates anything. The actual
// "link to existing" action (if any) is a separate, explicit, human-confirmed
// step (out of scope for this slice). RLS is the boundary: candidates are
// ALWAYS scoped to what the caller can already see (same org, agent record-
// scoping) — the probe can never become a cross-tenant existence oracle.

/**
 * POST /documents/dedup-check request — the sha256 (hex) the client computed of
 * the file it is about to upload. SAME field + bounds as `contentHash`
 * everywhere else (create/finalize): tolerant of the existing 1..128 bound so a
 * legacy/other-length hash still probes. `.strict()` rejects any extra field
 * (no smuggled scope/org override — scope comes ONLY from RLS + the caller's
 * role, never the client body).
 */
export const DedupCheckInput = z
  .object({
    contentHash: z.string().min(1).max(128),
  })
  .strict();
export type DedupCheckInputDto = z.infer<typeof DedupCheckInput>;

/**
 * A single dedup link candidate — an EXISTING, non-archived document in the
 * caller's scope sharing the probed contentHash. Metadata only (no r2Key, no
 * presigned URL, no PII): just enough for the FE to render the "קשר לקיים"
 * suggestion and link to the doc. `scope`/`scopeId` are the DH1 canonical
 * taxonomy scope (org|project|apartment|owner); `scopeId` is null for org-scope.
 */
export const DedupCandidateSchema = z.object({
  documentId: z.string().uuid(),
  type: z.string().min(1).max(64),
  scope: z.enum(['org', 'project', 'apartment', 'owner']),
  scopeId: z.string().uuid().nullable(),
  filename: z.string().min(1).max(255),
  createdAt: z.coerce.date(),
});
export type DedupCandidate = z.infer<typeof DedupCandidateSchema>;

/**
 * POST /documents/dedup-check response — the link candidates (newest first) +
 * a convenience `hasDuplicate` boolean. Empty `duplicates` ⇒ `hasDuplicate`
 * false (the file is new to the caller's scope). NEVER an oracle: a hash that
 * exists ONLY in another org returns the SAME empty result as a never-seen hash.
 */
export const DedupCheckResponseSchema = z.object({
  duplicates: z.array(DedupCandidateSchema),
  hasDuplicate: z.boolean(),
});
export type DedupCheckResponse = z.infer<typeof DedupCheckResponseSchema>;

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

/**
 * The REQUIRED document-type set per renewal TRACK — the SINGLE source of truth
 * for "what every project of this track must collect" (the DH2 advisory set).
 *
 * Moved here (the FE/BE contract) so BOTH sides read ONE definition:
 *   - BE: `apps/api/.../document-checklist.config.ts` re-exports this; the
 *     checklist endpoint probes the `documents` table per required type.
 *   - FE: the PARTY-BINDER board (binder slice 2) derives per-party
 *     required-vs-received completeness from this same constant — no second
 *     copy to drift, no new endpoint. Counts + doc-type keys only; NO PII.
 *
 * Required-set rationale (see the BE config header for the full reasoning):
 *   - agreement / land_registry / blueprint — the baseline every track needs.
 *   - regulation — added for pinui_binui's multi-building governance.
 *
 * These are ADVISORY expectations, deliberately a SMALL set the team can
 * realistically complete; widening is a one-line edit + a test update here.
 */
export const REQUIRED_DOC_TYPES_BY_TRACK: Readonly<
  Record<DocumentChecklistTrack, readonly DocumentType[]>
> = {
  tama38: ['agreement', 'land_registry', 'blueprint'],
  pinui_binui: ['agreement', 'land_registry', 'blueprint', 'regulation'],
  default: ['agreement', 'land_registry', 'blueprint'],
} as const;

/**
 * Map the raw `project_type` enum value to the checklist TRACK key. Tolerant: an
 * unknown/future value falls back to 'default' rather than throw, so the
 * advisory checklist / board completeness NEVER breaks on a new project type.
 *   - tama38_1, tama38_2 → 'tama38' (both תמ"א-38 variants share one set)
 *   - pinui_binui        → 'pinui_binui'
 *   - other / unknown    → 'default'
 */
export function trackForProjectType(projectType: string): DocumentChecklistTrack {
  switch (projectType) {
    case 'tama38_1':
    case 'tama38_2':
      return 'tama38';
    case 'pinui_binui':
      return 'pinui_binui';
    default:
      return 'default';
  }
}

/** All doc TYPES that are required by AT LEAST ONE track — the union across the
 *  three tracks. Useful when reasoning about completeness without a specific
 *  project's track in hand. Order follows first appearance across tracks. */
export function allRequiredDocTypes(): DocumentType[] {
  const seen = new Set<DocumentType>();
  for (const track of DocumentChecklistTrackEnum.options) {
    for (const t of REQUIRED_DOC_TYPES_BY_TRACK[track]) seen.add(t);
  }
  return [...seen];
}

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

// ── PARTY-BINDER board completeness (binder slice 2 — CONTRACT) ──────────────
// `GET /api/v1/documents/board-completeness` reports, per BINDER PARTY, the
// REQUIRED-vs-RECEIVED document completeness across the WHOLE board scope (the
// caller's org, or — for an agent — their assigned projects). The PARTY-BINDER
// board is ORG-WIDE and the documents list is keyset-paginated, so completeness
// CANNOT be computed client-side from a single 25-doc page (the bug this fixes:
// a 25-doc single page was compared against 21 projects' requirements, so every
// unloaded project's required types were counted "missing" → bogus "0/21"). The
// server computes it over ALL the scope's projects + ALL their documents in ONE
// aggregate pass — accurate, sub-second, no N+1.
//
// PRIVACY: counts + doc-type KEYS only. NEVER a document id/name, NEVER owner
// PII (national_id/phone/name). Completeness is a structural fact about the
// FILE SET, not about people — the same no-PII guarantee the DH2 checklist and
// the FE slice-2 math already hold.

/** The fixed set of binder PARTIES — the "who is responsible" axis of the
 *  PARTY-BINDER board. Built from the canonical {@link DOCUMENT_PARTY_VALUES}
 *  tuple (declared above the search query) so the search `party` filter and this
 *  enum can NEVER drift. Order is the canonical board order. SoT for BOTH the FE
 *  (`apps/web/.../lib/document-party.ts` re-exports) and the BE board-
 *  completeness endpoint — one definition, no drift. */
export const DocumentPartyEnum = z.enum(DOCUMENT_PARTY_VALUES);
export type DocumentParty = z.infer<typeof DocumentPartyEnum>;

/** Canonical ordered party list (the enum options), for stable board ordering. */
export const DOCUMENT_PARTIES = DocumentPartyEnum.options;

/**
 * Default PARTY per curated `DocumentType`. Every value of `DocumentTypeEnum`
 * MUST map to exactly one party; an unknown free-text `type` falls back to
 * `other` via {@link providerPartyForDocType}, so the board never silently
 * drops a document. Pure data mapping — no i18n (labels resolve at the FE).
 */
const PARTY_BY_DOC_TYPE: Readonly<Record<string, DocumentParty>> = {
  // owner — carries owner PII / the registry record
  land_registry: 'owner', // נסח טאבו
  id_document: 'owner', // תעודת זהות
  // appraiser — the financial / valuation file
  financial: 'appraiser',
  survey: 'appraiser', // שומה / הערכת שמאי
  // surveyor — the מודד's measurement map (distinct party from the appraiser)
  survey_map: 'surveyor', // מפת מדידה / תשריט מדידה
  // architect — the drawings
  blueprint: 'architect', // תוכנית / שרטוט
  floor_plan: 'architect', // תוכנית דירה
  // municipality — the authority's approvals
  permit: 'municipality', // היתר
  municipal_approval: 'municipality', // אישור / היתר עירייה
  // contractor — the signed renewal deal + the contractor's commitments
  agreement: 'contractor', // הסכם
  contract: 'contractor',
  guarantee: 'contractor', // ערבות / בטוחה
  schedule: 'contractor', // לוח זמנים — the contractor authors the timetable
  // lawyer — the legal framework + the עו״ד's opinion + the POA they hold
  regulation: 'lawyer', // תקנון / רגולציה
  legal_opinion: 'lawyer', // חוות דעת משפטית
  power_of_attorney: 'lawyer', // ייפוי כוח — drafted/held by the עו״ד (SENSITIVE)
  // supervisor — the מפקח's inspection report (S4-taxonomy: previously the
  // supervisor party had NO mapped type, so מפקח docs fell to "other").
  inspection_report: 'supervisor', // דו״ח פיקוח / דו״ח מפקח
  // neutral
  other: 'other',
};

/**
 * Resolve the default binder PARTY for a document `type`. Accepts the tolerant
 * wire `type` string (NOT only the curated enum); any unrecognised value falls
 * back to `other`. Pure + deterministic. SoT shared by FE + BE.
 */
export function providerPartyForDocType(docType: string): DocumentParty {
  const normalised = docType.trim().toLowerCase();
  return PARTY_BY_DOC_TYPE[normalised] ?? 'other';
}

/**
 * Phase 1 (board zoom-in / search `party` filter) — the curated doc TYPES that
 * roll up to a binder party (the inverse of {@link providerPartyForDocType} over
 * the curated map), plus whether the party is the `other` CATCH-ALL.
 *
 *  - `types` — the curated types whose default party === `party`.
 *  - `includesUnmapped` — true ONLY for `other`: the board's `other` bucket also
 *    holds any UNKNOWN / free-text type not in the curated map (so a party-filter
 *    on `other` must match `type NOT IN <all mapped types>` too, not just the
 *    literal `'other'`). For every named party it is false (an exact type IN-list
 *    is exhaustive). A party with no curated types (should that ever arise — every
 *    DOCUMENT_PARTY_VALUES party now maps ≥1 type as of S4-taxonomy) returns an
 *    EMPTY `types` + `includesUnmapped:false`, so the service can short-circuit
 *    to an empty result rather than emit a `type IN ()` that matches everything.
 *
 * Pure + deterministic; shared by FE + BE so the search filter and the board use
 * ONE mapping (no drift). NO PII — type keys only.
 */
export function docTypesForParty(party: DocumentParty): {
  types: DocumentType[];
  includesUnmapped: boolean;
} {
  const types: DocumentType[] = [];
  for (const [type, p] of Object.entries(PARTY_BY_DOC_TYPE)) {
    if (p === party) types.push(type as DocumentType);
  }
  return { types, includesUnmapped: party === 'other' };
}

/** One required doc-type a party is still missing — type KEY only (no PII, no
 *  ids/names). The FE resolves the Hebrew/English label. */
export const MissingRequiredTypeSchema = z.object({ type: DocumentTypeEnum });
export type MissingRequiredType = z.infer<typeof MissingRequiredTypeSchema>;

/**
 * Per-party completeness — TWO DISTINCT, NEVER-CONFLATED facts about one party
 * (counts + type keys only; NO PII, NO ids/names):
 *
 *   1. CORE-REQUIRED-SLOT gauge — `received` / `required` (+ `missingTypes`,
 *      `isComplete`, `hasRequirement`). "How many of the party's CORE required
 *      document slots are filled" (the `REQUIRED_DOC_TYPES_BY_TRACK` set, one
 *      slot per (project, requiredType)). A SMALL denominator (≈ project count),
 *      computed over the canonical project-scoped required types.
 *   2. DOCS-FILED rollup — `total` (+ `latestType`, `latestCreatedAt`). "How many
 *      documents of ANY type are filed under this party", the tile's headline.
 *
 * THESE ANSWER DIFFERENT QUESTIONS — the FE MUST render them as two separate
 * facts ("{total} מסמכים · מסמכי-ליבה {received}/{required}") and MUST NEVER
 * divide one by the other (the "0 מתוך 37" bug: a party with 37 filed docs but 0
 * of a required TYPE is "37 מסמכים · מסמכי-ליבה 0/3", never "0 מתוך 37"). The BE
 * computes BOTH over ONE aligned population (the same canonical scope resolver),
 * so the two numbers are coherent even though they count different things.
 */
export const PartyCompletenessSchema = z.object({
  party: DocumentPartyEnum,
  /** CORE-required gauge — distinct required (project,type) slots mapped to this
   *  party per REQUIRED_DOC_TYPES_BY_TRACK. 0 = no requirement. The DENOMINATOR of
   *  the "מסמכי-ליבה X/Y" gauge — NOT a doc count; never the denominator of `total`. */
  required: z.number().int().nonnegative(),
  /** CORE-required gauge — how many of those required slots have a matching
   *  received (non-archived) doc. The NUMERATOR of "מסמכי-ליבה X/Y". Bounded by
   *  `required`; UNRELATED to `total` (a party can have total≫0 yet received=0). */
  received: z.number().int().nonnegative(),
  /** True only when this party HAS a requirement and every slot is satisfied. */
  isComplete: z.boolean(),
  /** True when this party has ≥1 required slot (else don't render "0/0"). */
  hasRequirement: z.boolean(),
  /** Distinct required types still missing (deduped across projects), for the
   *  "חסר: שומה" gap copy. Length ≤ required-received. */
  missingTypes: z.array(MissingRequiredTypeSchema),
  // ── Phase 1 (board-summary) — the WHOLE-BOARD per-party document rollup. The
  // board previously derived its tile counts from ONE 25-doc keyset page (the
  // "counts lie" bug); these are computed SERVER-SIDE over EVERY non-archived doc
  // in scope so a party with >25 docs is no longer silently truncated. COUNTS +
  // TYPE KEYS ONLY — never a document id/name, never owner PII.
  //   • `total` — how many non-archived documents in scope roll up to this party
  //     (via providerPartyForDocType over the doc's actual type). DISTINCT from
  //     `received` (which counts satisfied REQUIRED slots): `total` is "how many
  //     docs are filed under this party", the tile's headline number.
  //   • `latestType` — the curated/wire TYPE KEY of the most-recent such doc
  //     (label resolved at the FE), or null when the party has no documents.
  //   • `latestCreatedAt` — that most-recent doc's createdAt, or null. A
  //     timestamp is NOT PII (it is when a file was filed, not about any person).
  /** DOCS-FILED headline — whole-board count of non-archived docs that roll up to
   *  this party (ANY type). The card's "{total} מסמכים" fact. NEVER divided into /
   *  by `received`/`required` — it is a separate question from the core-slot gauge. */
  total: z.number().int().nonnegative().default(0),
  /** Most-recent such doc's TYPE KEY (no id/name), or null when total === 0. */
  latestType: z.string().min(1).max(64).nullable().default(null),
  /** Most-recent such doc's createdAt, or null when total === 0. */
  latestCreatedAt: z.coerce.date().nullable().default(null),
});
export type PartyCompleteness = z.infer<typeof PartyCompletenessSchema>;

/**
 * S2 (org cockpit) — ONE project that is BEHIND on its core required documents.
 * The project-attention axis the party-only board could not express: a manager
 * with 100 projects must see WHICH projects are short, worst-first, each naming
 * the responsible parties + the missing types so the gap is a one-click upload,
 * not a flat label.
 *
 * COUNTS + TYPE/PARTY KEYS + the project NAME only — NO owner PII (national_id /
 * phone / owner name). The project name is an org-internal LABEL (the same class
 * of label the signatures situation-picture already returns on its wire); it is
 * never owner PII. Computed in the SAME aggregate pass as `byParty` (the
 * per-project required/received slot rollup is already materialized server-side),
 * so this adds NO query and stays sub-second.
 */
export const ProjectBehindSchema = z.object({
  projectId: z.string().uuid(),
  /** Org-internal project label (bidi-stripped + <NameDisplay>-wrapped at the FE).
   *  NOT owner PII — the project's own name. */
  projectName: z.string().min(1).max(255),
  /** Core required slots for this project (its track's REQUIRED_DOC_TYPES set). */
  coreRequired: z.number().int().positive(),
  /** Core required slots already filled by a received (non-archived) doc. */
  coreReceived: z.number().int().nonnegative(),
  /** The required types this project is still missing (deduped), each carrying its
   *  derived responsible PARTY so the FE can name "מהשמאי / מהאדריכל" + deep-link
   *  the one-click upload to ?type=&party=&projectId=. Type + party KEYS only. */
  missing: z.array(
    z.object({
      type: DocumentTypeEnum,
      party: DocumentPartyEnum,
    }),
  ),
});
export type ProjectBehind = z.infer<typeof ProjectBehindSchema>;

/** S2 — server cap on `projectsBehind` (the cockpit shows the worst N + a "+M"
 *  tail / "הצג הכל" affordance; rendering hundreds of cards into the surface
 *  would itself be a flat wall). */
export const PROJECTS_BEHIND_CAP = 12;

/** GET /api/v1/documents/board-completeness response (under `data`). Board-wide
 *  per-party rollup + the summary the orientation line needs. Counts + type
 *  keys only — NEVER PII, NEVER ids/names. */
export const BoardCompletenessSchema = z.object({
  /** Per-party breakdown, ALWAYS one entry per `DOCUMENT_PARTIES` (stable order).
   *  A party with no requirement has required:0/received:0/hasRequirement:false. */
  byParty: z.array(PartyCompletenessSchema),
  /** Distinct parties (canonical order) with an UNMET requirement (received <
   *  required). The orientation line names the first few and "+N"s the rest. */
  unmetParties: z.array(DocumentPartyEnum),
  /** True when ≥1 required slot exists anywhere in the board scope. */
  hasAnyRequirement: z.boolean(),
  /** True when every party with a requirement has met it (and ≥1 requirement). */
  allRequirementsMet: z.boolean(),
  // ── S2 (org cockpit) — the PROJECT-attention axis ──────────────────────────
  /** Projects with an UNMET core required set, ranked WORST-FIRST (fewest core
   *  slots filled, then most missing). The cockpit's ranked attention cards read
   *  from this; a manager at 100 projects sees WHICH are behind, not just which
   *  party. Capped server-side at {@link PROJECTS_BEHIND_CAP}. Empty ⇒ every
   *  in-scope project with a requirement has met its core set (calm all-clear). */
  projectsBehind: z.array(ProjectBehindSchema).default([]),
  /** Total in-scope projects that HAVE a core requirement (the denominator the
   *  cockpit pulse uses: "{behind} מתוך {withRequirement} פרויקטים מאחור"). */
  projectsWithRequirement: z.number().int().nonnegative().default(0),
  /** TRUE count of projects BEHIND on their core set — the full magnitude BEFORE
   *  the {@link PROJECTS_BEHIND_CAP} slice. `projectsBehind` is the capped DISPLAY
   *  list (≤ cap); THIS is the number the cockpit must show ("{behindTotal} מתוך
   *  {withRequirement} מאחור") and the one "met" is derived from
   *  ({withRequirement} − {behindTotal}). NEVER derive "met"/"behind" from the
   *  capped array length — at scale that over-states "completed" (12 shown out of
   *  97 behind ⇒ a false "85 are done"). */
  projectsBehindTotal: z.number().int().nonnegative().default(0),
  /** True when `projectsBehind` was capped (more behind projects exist than the
   *  cap) → the cockpit shows a "+N" tail / "הצג הכל" affordance. */
  projectsBehindCapped: z.boolean().default(false),
});
export type BoardCompleteness = z.infer<typeof BoardCompletenessSchema>;

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

// ── FL-5 (MASTER-PLAN-V13 Wave A) — נסח/tabu BACKFILL REMEDIATION SWEEP ──────
// `POST /api/v1/documents/remediation-sweep` re-classifies PRE-EXISTING
// documents whose content is נסח/tabu (land_registry) but were uploaded BEFORE
// the DH3 classifier existed, so they were never typed `land_registry` and —
// critically — never derived `sensitive = true` (the #450 HIGH follow-up: a
// tabu-content doc that lists every owner's national_id but is stored as
// `other`/`document` is a PII doc WITHOUT the step-up gate / at-rest envelope).
//
// The sweep re-runs the SAME DH3 classifier (filename + declared mime — the
// signals already stored on each row; NO content fetch, no PII read) over the
// org's documents and reports the docs it would re-type to `land_registry`
// (which then DERIVES sensitive = true, turn-ON only, exactly as create/PATCH).
//
// DRY-RUN BY DEFAULT (the whole point): the default invocation REPORTS the
// proposed transitions and COMMITS NOTHING. A commit happens ONLY with an
// explicit `dryRun: false`. IDEMPOTENT: a doc already typed `land_registry`
// (and sensitive) is never a candidate, so applying twice is a no-op.
//
// CONFIDENCE FLOOR: only HIGH-confidence land_registry matches are remediated
// (REMEDIATION_MIN_CONFIDENCE) so an ambiguous filename never auto-retypes a
// doc — this is a SECURITY sweep (it only ever turns sensitivity ON), never a
// generic re-tagger. SENSITIVITY IS NEVER WEAKENED: the sweep only flips
// `type → land_registry` + `sensitive → true`; it never clears a flag.

/** The MINIMUM classifier confidence a `land_registry` suggestion must reach to
 *  be a remediation candidate. Tuned to the DH3 filename/content נסח/tabu rules
 *  (>=0.85) so only an UNAMBIGUOUS tabu signal retypes a pre-existing doc. */
export const REMEDIATION_MIN_CONFIDENCE = 0.85;

/** Hard ceiling on docs SCANNED per sweep invocation (defense-in-depth: the
 *  sweep is a maintenance batch, never an unbounded full-table scan on one
 *  request). Keyset-free: the sweep is idempotent, so a follow-up call simply
 *  picks up where the last left off (already-remediated docs are skipped). */
export const REMEDIATION_MAX_SCAN = 1_000;

/** POST /documents/remediation-sweep request. DRY-RUN BY DEFAULT: `dryRun`
 *  absent or true ⇒ report only, commit nothing. `dryRun: false` ⇒ apply the
 *  proposed transitions. `.strict()` — no smuggled org/scope override. */
export const RemediationSweepInput = z
  .object({
    /** DEFAULT TRUE (report-only). Must be EXPLICITLY false to apply. */
    dryRun: z.boolean().optional().default(true),
    /** Max docs to SCAN this invocation (1..REMEDIATION_MAX_SCAN). */
    limit: z.coerce.number().int().min(1).max(REMEDIATION_MAX_SCAN).default(REMEDIATION_MAX_SCAN),
  })
  .strict();
export type RemediationSweepInputDto = z.infer<typeof RemediationSweepInput>;

/** One proposed (dry-run) or applied transition. METADATA ONLY — the document
 *  id + the type/sensitive transition + the classifier confidence/reason. NO
 *  filename, NO content, NO PII (the `reason` is the DH3 content-free key). */
export const RemediationItemSchema = z.object({
  documentId: z.string().uuid(),
  fromType: z.string().min(1).max(64),
  toType: DocumentTypeEnum,
  /** The doc's sensitive flag BEFORE the sweep. */
  wasSensitive: z.boolean(),
  /** The sensitive flag the sweep DERIVES (always true for land_registry —
   *  turn-ON only; the sweep never sets this false). */
  willBeSensitive: z.boolean(),
  confidence: z.number().min(0).max(1),
  /** DH3 content-free reason key (e.g. 'filename_nesach'). */
  reason: z.string().min(1).max(64),
});
export type RemediationItem = z.infer<typeof RemediationItemSchema>;

/** POST /documents/remediation-sweep response (under `data`). Carries the COUNTS
 *  + a bounded SAMPLE of affected items (ids + transitions only). `applied`
 *  echoes whether this was a real commit (dryRun=false) or a report (dryRun=true,
 *  the default). `scanned` = docs inspected; `candidates` = how many WOULD/DID
 *  change; `sample` is capped (the full set is not streamed — ids only, no PII). */
export const RemediationSweepResultSchema = z.object({
  /** false ⇒ DRY-RUN report (nothing was written). true ⇒ changes committed. */
  applied: z.boolean(),
  scanned: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  /** Bounded sample of the affected docs (REMEDIATION_SAMPLE_MAX). */
  sample: z.array(RemediationItemSchema),
});
export type RemediationSweepResult = z.infer<typeof RemediationSweepResultSchema>;

/** Max items echoed in the `sample` array (the report is a SUMMARY, not a full
 *  dump — ids only, no PII, but still bounded so the response stays small). */
export const REMEDIATION_SAMPLE_MAX = 50;
