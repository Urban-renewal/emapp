import { z } from 'zod';

import { HttpOrHttpsUrlSchema } from './safe-url';

// Canonical Import contract (Doc 11 SoT; Phase 6 S8).
//
// SECURITY (information-confidentiality + ISO A.18.1.4):
//  - `file_r2_key` (the storage pointer) is NEVER exposed on the wire.
//    Same posture as documents — clients get a short-lived presigned URL
//    minted server-side AFTER authorization.
//  - Content-hash is a sha256 (lowercase hex) the FE computes BEFORE
//    upload. Server-side it is used for client-consistency (the worker
//    can verify the uploaded blob hashes to this).
//  - `file_size_bytes` hard-bounded at 50MB (matches migration 0022's
//     file_size_bytes CHECK + zip-preflight MAX_DECOMPRESSED_BYTES).
//  - `dry_run` lets a Manager validate WITHOUT persisting domain rows —
//    a pre-onboarding sanity check (T6.5).
//
// State machine (mirrors apps/worker/src/handlers/import-job.handler.ts
// FORWARD table). The wire surface includes 'awaiting_mapping' (D.34)
// even for clients that don't yet show a mapping wizard — they should
// render the state but disable the "view results" action.

/** Hard ceiling on uploaded Excel size (50MB). Mirrors migration 0022
 *  CHECK constraint + worker zip-preflight MAX_DECOMPRESSED_BYTES. */
export const IMPORT_MAX_SIZE_BYTES = 52_428_800;

/** sha256 hex (lowercase, 64 chars).
 *
 *  v8 SOLID-2 — CANONICAL wire shape:
 *    FE MUST send bare hex (no `sha256:` prefix). The historic prefix
 *    has been removed from the contract: ambiguous shapes mean two
 *    clients computing the "same" hash send different strings, which
 *    breaks any future content-integrity comparison. The schema
 *    enforces bare hex; the controller no longer normalises (there
 *    is nothing to normalise — the regex rejects anything else
 *    before the controller sees it).
 *
 *  FE recipe (per Doc 11):
 *    `const buf = await file.arrayBuffer();`
 *    `const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))`
 *    `  .map(b => b.toString(16).padStart(2,'0')).join('');`
 *    `// hash is exactly 64 lowercase hex chars — pass as fileContentHash`
 *
 *  DB column stores `sha256:<hex>` (the prefix is a self-describing
 *  format marker for the persisted value, not a wire-format quirk).
 *  See `apps/api/src/modules/imports/imports.service.ts:create()`. */
export const Sha256HexLowerSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'must be exactly 64 lowercase hex chars (sha256, no prefix)',
});

/** Status enum — MUST match migration 0022 + 0027 CHECK. */
export const ImportStatusEnum = z.enum([
  'queued',
  'parsing',
  'validating',
  'persisting',
  'done',
  'failed',
  'cancelled',
  'awaiting_mapping',
]);
export type ImportStatus = z.infer<typeof ImportStatusEnum>;

/** Wire representation — never includes file_r2_key or pg_boss_job_id. */
export const ImportJobSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  status: ImportStatusEnum,
  fileName: z.string().min(1).max(255),
  fileSizeBytes: z.number().int().min(1).max(IMPORT_MAX_SIZE_BYTES),
  totalRows: z.number().int().min(0).nullable(),
  processedRows: z.number().int().min(0),
  okRows: z.number().int().min(0),
  failedRows: z.number().int().min(0),
  dryRun: z.boolean(),
  createdBy: z.string().uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
});
export type ImportJob = z.infer<typeof ImportJobSchema>;

/** POST /api/v1/imports — create + return presigned PUT URL (step 1
 *  of the two-phase flow; step 2 is POST /imports/:id/start). */
export const CreateImportInput = z
  .object({
    projectId: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    fileSizeBytes: z.number().int().min(1).max(IMPORT_MAX_SIZE_BYTES),
    fileContentHash: Sha256HexLowerSchema,
    dryRun: z.boolean().optional().default(false),
    // v8 Sec-15 / SOLID-1: format-constrained to make guessing /
    // enumerating other Managers' keys infeasible. The DB's partial
    // UNIQUE index is on (org_id, idempotency_key) — without a format
    // constraint, a key like "1", "2", "3" could be tried by an
    // attacker to detect prior uses (a 409 conflict leaks existence).
    // Service-side we also scope replay-lookup to (org_id, created_by,
    // idempotency_key) so cross-Manager probing returns the SAME 409
    // as a real conflict from a UUID-shaped key. The format constraint
    // is the FIRST line of defense; the service-side scope is the
    // second. UUIDv4 is the FE-recommended shape but we accept any
    // 16-64 char base62/base64url-safe string to leave room for the
    // FE to use a content-derived id (e.g. `${userId}-${fileHash}`).
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,64}$/, {
        message: 'must be 16-64 chars of [A-Za-z0-9_-]',
      })
      .optional(),
  })
  .strict();
export type CreateImport = z.infer<typeof CreateImportInput>;

/** Response shape — the row + a short-lived PUT URL. */
export const ImportUploadResponseSchema = z.object({
  import: ImportJobSchema,
  // §RED-1 — scheme allowlist: prevents `javascript:` / `data:` URLs
  // from reaching `<a href>` or `window.open` if the BE ever drifts.
  uploadUrl: HttpOrHttpsUrlSchema,
  uploadExpiresInSeconds: z.number().int().positive(),
});
export type ImportUploadResponse = z.infer<typeof ImportUploadResponseSchema>;

/** POST /api/v1/imports/:id/start — enqueue the worker job AFTER the
 *  client uploads to R2. Body is intentionally empty (UUID in path is
 *  the only required argument); we accept a strict empty object so
 *  the Zod pipe rejects extraneous fields rather than silently
 *  ignoring them. */
export const StartImportInput = z.object({}).strict();
export type StartImport = z.infer<typeof StartImportInput>;

/** GET /api/v1/imports/:id/errors — paginated rows from import_job_errors. */
export const ImportErrorSchema = z.object({
  id: z.string().uuid(),
  rowNumber: z.number().int().positive(),
  code: z.string().min(1).max(64),
  // Free-text message is BOUNDED — the writer (worker validateStage)
  // already strips PII; defense in depth: length cap on the wire.
  message: z.string().min(1).max(500),
  field: z.string().max(64).nullable(),
  createdAt: z.date(),
});
export type ImportError = z.infer<typeof ImportErrorSchema>;

/** Cursor format for /imports/:id/errors listing (keyset on rowNumber
 *  asc + id desc — same pattern as the rest of the API). */
export const ListImportErrorsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional().default(100),
    cursor: z.string().min(1).max(255).optional(),
  })
  .strict();
export type ListImportErrorsQueryDto = z.infer<typeof ListImportErrorsQuery>;

/** GET /api/v1/imports — paginated list. §P0-2 closure (post-S11
 *  manual smoke caught the FE→BE mismatch: FE was calling this endpoint
 *  but BE had no @Get() handler, so the proxy 404'd). Keyset cursor
 *  on (createdAt desc, id desc) — same pattern as documents/projects. */
export const ListImportsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    cursor: z.string().min(1).max(255).optional(),
    /** Optional filter — list only imports for one project. */
    projectId: z.string().uuid().optional(),
  })
  .strict();
export type ListImportsQueryDto = z.infer<typeof ListImportsQuery>;

/** D.34 — wizard endpoint: POST /api/v1/imports/:id/mapping.
 *  Used to provide a manual column mapping when a row sat in
 *  `awaiting_mapping`. The body is the same `ColumnMapping` shape
 *  the worker's resolvers produce — keyed by canonical field with
 *  the column INDEX as the value. */
const CanonicalFieldsEnum = z.enum([
  'national_id',
  'phone',
  'name',
  'apartment_number',
  'building_address',
  'ownership_pct',
]);

export const SubmitMappingInput = z
  .object({
    columns: z.record(CanonicalFieldsEnum, z.number().int().min(0).max(1023)).refine((cols) => {
      // Required fields: national_id, phone, name, apartment_number,
      // building_address. ownership_pct is optional.
      const required = [
        'national_id',
        'phone',
        'name',
        'apartment_number',
        'building_address',
      ] as const;
      return required.every((k) => typeof cols[k] === 'number');
    }, 'all required canonical fields must be mapped'),
    // Optional friendly name the manager wants saved alongside the
    // template — pre-bounded to keep the audit metadata minimal.
    templateName: z.string().min(1).max(120).optional(),
  })
  .strict();
export type SubmitMapping = z.infer<typeof SubmitMappingInput>;

/** Response on successful submission: re-enqueued + the saved template
 *  id (so the FE can show "saved as template"). */
export const SubmitMappingResponseSchema = z.object({
  import: ImportJobSchema,
  templateId: z.string().uuid(),
});
export type SubmitMappingResponse = z.infer<typeof SubmitMappingResponseSchema>;

// ─────────────────────────────────────────────────────────────────────
// SSE event contract — GET /api/v1/imports/:id/stream
// ─────────────────────────────────────────────────────────────────────
//
// v7 audit Agent A HIGH-1 / Agent C HIGH-?: the SSE endpoint was
// emitting events typed only as `{ event: 'progress'|'end'|'gone';
// data: Record<string, unknown> }` — the FE has no way to know what
// fields to expect for each variant without reading the API source.
// That's exactly the FE/BE drift Doc 11 says shared-types exists to
// prevent.
//
// We model the three variants as a discriminated union (Zod's
// preferred shape) so the FE can `parse(...).event` switch and get
// narrowed fields automatically. The status enum on `progress`/`end`
// is the SAME ImportStatusEnum — no parallel "wire status" to drift
// out of sync.

/** Periodic progress frame — the worker has advanced to a new
 *  status or row counters changed. The FE re-renders from this. */
export const ImportSseProgressSchema = z.object({
  event: z.literal('progress'),
  data: z.object({
    id: z.string().uuid(),
    status: ImportStatusEnum,
    totalRows: z.number().int().min(0).nullable(),
    processedRows: z.number().int().min(0),
    okRows: z.number().int().min(0),
    failedRows: z.number().int().min(0),
    /** ISO-8601 UTC. The FE uses this to debounce noisy re-renders
     *  and to display "last updated Xs ago". */
    updatedAt: z.string().datetime(),
  }),
});

/** Terminal frame — the job reached `done`/`failed`/`cancelled`.
 *  After this the FE should close the EventSource. */
export const ImportSseEndSchema = z.object({
  event: z.literal('end'),
  data: z.object({
    id: z.string().uuid(),
    status: ImportStatusEnum,
  }),
});

/** Sentinel — the import row is no longer visible (404 mid-stream).
 *  Likely cause: the Manager cancelled+archived from a different tab.
 *  FE should close the EventSource and surface "import gone". */
export const ImportSseGoneSchema = z.object({
  event: z.literal('gone'),
  data: z.object({ id: z.string().uuid() }),
});

/** Discriminated union of all SSE frames. Used by:
 *   - API (imports.service): `encodeSseFrame(ev: ImportSseEvent)`
 *   - FE  (imports hook):    `ImportSseEventSchema.parse(JSON.parse(line))`
 *  Adding a fourth variant is a contract change — both sides will
 *  fail to compile until they handle it (intentional). */
export const ImportSseEventSchema = z.discriminatedUnion('event', [
  ImportSseProgressSchema,
  ImportSseEndSchema,
  ImportSseGoneSchema,
]);
export type ImportSseEvent = z.infer<typeof ImportSseEventSchema>;
export type ImportSseProgress = z.infer<typeof ImportSseProgressSchema>;
export type ImportSseEnd = z.infer<typeof ImportSseEndSchema>;
export type ImportSseGone = z.infer<typeof ImportSseGoneSchema>;
