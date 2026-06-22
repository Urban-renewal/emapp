# EMAPP — File / Document Rules Catalog

> Complete, source-verified enumeration of every FILE/DOCUMENT-based rule in the
> NestJS API + worker. For each rule: **what it does**, the **exact check it is
> based on** (signal / regex / threshold / byte-signature / field-format), the
> **confidence/threshold** if any, and the **verifying test**.
>
> Compiled 2026-06-22 by reading the source directly (no summaries). See
> **Verification basis** + **Completeness** at the bottom.

---

## Area 1 — Document-type CLASSIFICATION (heuristic, suggest-only)

Source: `apps/api/src/modules/documents/document-classifier.ts`
Constants: `packages/shared-types/src/document.ts`
Verifying test: `apps/api/src/modules/documents/document-classifier.spec.ts`

The classifier is **PURE / suggest-only** — it never writes or mutates a doc;
the human confirms the type. It ranks `doc_type` suggestions from three signal
families, keeps the highest-confidence hit per docType, and applies a small
multi-signal bonus.

### 1a. FILENAME_RULES — 22 regex → docType (signal = `filename`)
The regex is tested against the **lower-cased** filename. Grouped by docType
(every rule is a bounded/anchored regex, linear-time on the 255-char-max name):

| docType | Signals (Hebrew + latin tokens) | Confidence range |
|---|---|---|
| `land_registry` | `נסח` (0.9), `טאבו` (0.9), whole-token `tabu` bounded by sep/dot (0.85), `land[_- ]registry` (0.85) | 0.85–0.90 |
| `agreement` | `הסכם` (0.85), `חוזה` (0.8), `agreement` (0.8), `contract` (0.6) | 0.60–0.85 |
| `regulation` | `תקנון` (0.9), `regulation` (0.8), `by[_- ]laws` (0.7) | 0.70–0.90 |
| `blueprint` | `תוכנית`/`תכנית` (0.8), `שרטוט` (0.8), `blueprint` (0.85), `\.dwg$` extension (0.9) | 0.80–0.90 |
| `floor_plan` | `floor[_- ]plan` (0.75), `תשריט` (0.7) | 0.70–0.75 |
| `id_document` | `תעודת זהות` (0.85), `\bid[_- ](card|document)\b` (0.6) | 0.60–0.85 |
| `permit` | `היתר` (0.75), `permit` (0.75) | 0.75 |
| `financial` | `שומה` (0.65), `financial` (0.6) | 0.60–0.65 |

### 1b. CONTENT_RULES — 5 body-phrase → docType (signal = `content_text`)
Run **only** when the leading-bytes sample `looksTextual()` (UTF-8, no NUL,
<10% control bytes in first 512). Phrases are document-body markers, so high
confidence:

| Phrase (regex) | docType | Confidence |
|---|---|---|
| `לשכת רישום המקרקעין` | `land_registry` | 0.92 |
| `נסח רישום` | `land_registry` | 0.90 |
| `גוש[\s:]+\d+` | `land_registry` | 0.75 |
| `הסכם התחדשות` | `agreement` | 0.85 |
| `תקנון הבית המשותף` | `regulation` | 0.88 |

### 1c. DWG magic-byte rule (signal = `magic_byte`)
- **Check:** leading ASCII bytes == `"AC10"` (AutoCAD DWG `AC10..AC1032`).
- **Result:** `blueprint`, confidence **0.85**. The only magic family that
  carries a real docType hint (PDF/PNG/ZIP only corroborate the declared MIME,
  so no suggestion is manufactured from them).

### 1d. MIME_PRIORS — weak last-resort (signal = `mime`)
- **Check:** declared `mimeType` lookup, **only applied when `hits.length === 0`**.
- `application/pdf` → `agreement` (0.2); `image/png`/`image/jpeg` → `other` (0.1).
  Deliberately tiny so it never out-ranks a real signal.

### 1e. Multi-signal bonus + ceiling (ranker)
- **Rule:** keep best hit per docType; add `+0.05` per **additional distinct
  signal** that voted for that docType; cap at **0.98** (`CONFIDENCE_CEILING`)
  so a suggestion never reads as certain. Sort DESC by confidence, tie-break by
  docType for a stable order.
- **Sample cap:** the inspected sample is hard-capped to
  `CLASSIFY_SAMPLE_MAX_BYTES = 8_192` (leading bytes only). Request DTO caps
  `sampleBase64` to `CLASSIFY_SAMPLE_MAX_BASE64_CHARS = 12_000` at the Zod
  boundary; re-checked post-decode.

### 1f. `remediationLandRegistryMatch` — backfill confidence floor (FL-5)
- **What:** decides whether a *pre-existing* doc (metadata only — filename +
  declared mime, **no content fetch**) is an unambiguous tabu/נסח
  `land_registry` that should be re-typed + flipped `sensitive=true`.
- **Check:** re-runs `classifyDocument`; returns non-null **only if** the
  TOP-ranked suggestion is `land_registry` **AND** its confidence ≥
  `REMEDIATION_MIN_CONFIDENCE = 0.85`. Otherwise `null` (no false-positive retype).
- Consumed by `DocumentsService.remediationSweep` (dry-run by default; idempotent;
  turn-ON-only; org-scoped; capped at `REMEDIATION_SAMPLE_MAX = 50` sample,
  `input.limit` scanned).

**Rule count (Area 1): 22 filename + 5 content + 1 DWG-magic + 3 mime-priors + 2 ranker (bonus/ceiling) + 1 remediation-floor = 34 rules.**

---

## Area 2 — Required-document CHECKLIST (advisory completeness)

Source: `apps/api/src/modules/projects/document-checklist.config.ts`
Verifying tests: `apps/api/src/modules/projects/document-checklist.config.spec.ts`
(pure rules) + `apps/api/src/modules/projects/projects-document-checklist.spec.ts`
(service wiring).

**Advisory only** — the checklist service probes the `documents` table for a
project-scoped doc of each required type and auto-ticks `present`. It NEVER
gates or mutates project status.

### 2a. Required doc_types per track (`REQUIRED_DOC_TYPES_BY_TRACK`)
| Track | Required doc_types |
|---|---|
| `tama38` | `agreement`, `land_registry`, `blueprint` |
| `pinui_binui` | `agreement`, `land_registry`, `blueprint`, **`regulation`** (extra — pinui-binui's multi-building governance) |
| `default` | `agreement`, `land_registry`, `blueprint` |

### 2b. Track derivation (`trackForProjectType`)
- `tama38_1`, `tama38_2` → `tama38`
- `pinui_binui` → `pinui_binui`
- anything else (`other` / future) → `default` (tolerant fallback, never throws).

### 2c. Completeness % (`checklistCompletionPct`)
- **Formula:** `round(presentCount / totalCount * 100)`.
- **Guard:** `totalCount <= 0` → `0%` (divide-by-zero defense).

**Rule count (Area 2): 3 per-track required-sets + 3 track-derivation mappings + 1 completeness formula = 7 rules.**

---

## Area 3 — MAGIC-BYTE validation + UPLOAD SCAN GATE (defense-in-depth)

Sources: `apps/api/src/modules/documents/magic-bytes.ts`,
`apps/api/src/modules/documents/documents.service.ts` (scanGate / uploadContent),
`packages/db/src/providers/scan/scan.interface.ts`.
Verifying test: `apps/api/src/modules/documents/documents-magic-byte.spec.ts`
(scan-provider behaviour: `packages/db` scan provider specs).

### 3a. MIME allow-list (`DocumentMimeEnum`)
- **Accepted MIMEs:** pdf · png · jpeg · webp · gif · xlsx · xls · csv · docx ·
  doc · text/plain. **Dangerous active-content types (html/svg/executables) are
  excluded by the enum** — so an un-tabled allow-listed MIME is benign.

### 3b. Magic-byte signatures (`verifyMagicBytes`) — the leading-byte table
A declared MIME present in the table is **ENFORCED**: leading bytes must match
a signature, else `{ ok:false }` → upload rejected.

| MIME family | Leading-byte signature (offset 0 unless noted) |
|---|---|
| `application/pdf` | `25 50 44 46` (`%PDF`) |
| `image/png` | `89 50 4E 47 0D 0A 1A 0A` |
| `image/jpeg` | `FF D8 FF` |
| `image/webp` | `52 49 46 46 ** ** ** ** 57 45 42 50` (`RIFF....WEBP`, bytes 4-7 wildcard) |
| `image/gif` | `47 49 46 38 37 61` (GIF87a) **or** `...38 39 61` (GIF89a) |
| docx + xlsx (OOXML) | ZIP local-file-header `50 4B 03 04` **or** empty-EOCD `50 4B 05 06` |
| doc + xls (legacy Office) | OLE2 compound-file `D0 CF 11 E0 A1 B1 1A E1` |
| `text/plain`, `text/csv` | **NOT verified** (no reliable magic — declared MIME trusted) |
| MIME in allow-list but absent from table | **NOT blocked** (no signature ⇒ no spoof evidence) |
| empty buffer | `{ ok:true }` (size handled upstream) |

- **Gate (`DOCUMENT_TYPE_MISMATCH_CODE = document_type_mismatch`, HTTP 409):**
  on mismatch the object is **archived + purged + rejected**, fail-closed, same
  posture as an infected file. Runs in `scanGate` (presign path) and
  `uploadContent` (sensitive content path). File bytes are never logged.

### 3c. Anti-malware SCAN gate (`IFileScanProvider`, P0.B1)
- **Check:** after finalize/content-upload, the object is scanned; the verdict is
  one of `clean | infected | error`.
- **Rule (fail-closed):** download is served **only** when
  `scan_status === 'clean'`. `infected` **or** `error` (incl. a thrown scanner,
  exceeded byte ceiling, or unreachable engine) → archive + record verdict +
  purge + reject (`DOCUMENT_SCAN_REJECTED_CODE = document_scan_rejected`, 409).
  A provider that cannot reach its engine MUST return `error`, never `clean`.
- Dev/test provider = `NoopFileScanProvider` (always `clean`); prod =
  `ClamAvFileScanProvider`.

### 3d. Upload size ceiling
- **`DOCUMENT_MAX_SIZE_BYTES = 52_428_800` (50 MB)** — enforced at the Zod DTO
  (`sizeBytes.max`), at the presigned PUT (`maxSizeBytes`), and as the
  scan-read ceiling (`readObjectBytes` throws `object_exceeds_scan_ceiling`).

### 3e. Integrity gate (finalize / content-upload)
- **Two-layer (finalize):** (1) client-consistency — finalize-declared
  `sizeBytes`/`contentHash` must equal the create-declared values; (2)
  storage-attestation — when R2 can attest, the object's actual content-length
  (and sha256 when available) must match. Mismatch → archive + purge + 409
  `document_integrity_mismatch` with `details.field` = `'size' | 'hash'` (size
  checked first).
- **Sensitive content path (`uploadContent`):** server **recomputes**
  `sha256(body)` over the actual raw bytes and compares to `contentHash`
  (stronger than finalize layer-2); size checked first. Mismatch → 400 + field;
  nothing stored, row left intact for retry.

### 3f. Presign TTLs (storage.ts)
- Upload presign TTL = `UPLOAD_URL_TTL_SECONDS = 300` (5 min); download presign
  TTL = `DOWNLOAD_URL_TTL_SECONDS = 120` (2 min). Download forces
  `attachment` + sanitized filename + pinned response content-type (no MIME-sniff).

**Rule count (Area 3): 1 MIME allow-list + ~10 magic-signature families + 1 type-mismatch gate + 1 scan verdict gate + 1 size ceiling + 2 integrity gates + 2 presign TTLs ≈ 18 rules.**

---

## Area 4 — SENSITIVITY / at-rest ENCRYPTION registry

Sources: `apps/api/src/modules/documents/documents.service.ts`
(`SENSITIVE_DOC_TYPES`, envelope encrypt/decrypt),
`apps/api/src/modules/documents/doc-encryption-registry.ts` (key registry).
Verifying tests: `doc-encryption-registry.spec.ts` (key registry parsing),
`doc-encryption-7d.spec.ts` (envelope format — pinned NO-AAD invariant; referenced in source).

### 4a. Sensitive-by-type rule (`SENSITIVE_DOC_TYPES`)
- **Check:** `sensitive = SENSITIVE_DOC_TYPES.has(input.type) || input.sensitive === true`.
- **Sensitive doc_types:** `id_document`, `financial`, **`land_registry`** (a
  נסח טאבו lists every owner's national_id → PII-dense by definition).
- **TURN-ON ONLY:** the client may opt IN any type, but `sensitive:false` can
  NEVER force a sensitive-by-type doc off the gate. PATCH-to-sensitive-type and
  the remediation sweep also re-derive `sensitive=true`, never false.
- **Consequences of sensitive=true:** (1) no presigned PUT — bytes flow through
  `POST /documents/:id/content`; (2) AES-256-GCM envelope-encrypted at rest;
  (3) OTP step-up required on download (`pii_step_up_required`, 403); (4)
  structurally EXCLUDED from the non-sensitive contractor share tier.

### 4b. PII step-up unlock gate (`assertPiiUnlocked`)
- **Check:** a sensitive doc is served only when the caller's CURRENT session
  holds `pii_unlocked_at NOT NULL` and **younger than**
  `security.piiUnlockTtlMinutes` (org setting, default **60 min**). Else 403
  `pii_step_up_required`. Fail-closed: unknown/ghost session → locked.

### 4c. At-rest envelope format
- **Layout:** `'EMAPPENC'(8B) | version(1B=0x01) | keyId(2B) | iv(12B) |
  tag(16B) | ciphertext` (AES-256-GCM, random IV per object, **NO AAD** — pinned
  by spec). Malformed envelope → 500 `document_decrypt_failed` (bytes never logged).

### 4d. Key registry (`DocKeyRegistry`, FL-3) — rotation-ready, fail-closed
- **Legacy form:** a bare 44-char base64 key → `{1: key}`, active keyId 1
  (`LEGACY_DEFAULT_KEY_ID`, must stay 1).
- **v2 registry form:** `v2;active=<id>;<id>=<b64>;...` → multi-key map.
- **Validation rules (fail-closed at boot):** keyId is a strict integer in
  `[1, 65535]` (no leading zeros); each key must base64-decode to exactly 32
  bytes (44-char b64); `active=` must be present, unique, and reference a
  defined key; no duplicate keyIds; absent/empty env → throws. Unknown keyId at
  decrypt → 503 `doc_encryption_unavailable` (never a plaintext fallback).
- `assertDocEncryptionConfig()` runs at API boot so a bad config crashes at
  deploy, not on first download.

**Rule count (Area 4): 1 sensitive-by-type set (3 types) + 1 turn-on-only invariant + 1 step-up TTL gate + 1 envelope format + ~7 key-registry validation rules = ~11 rules.**

---

## Area 5 — DEDUP (content-hash exact-match)

Source: `apps/api/src/modules/documents/documents.service.ts` (`dedupCheck`,
`buildDedupResponse`).
Verifying tests: `documents-dedup.spec.ts` (service / zero-leak),
`documents-dedup-contract.spec.ts` (wire shape).

- **What:** read-only probe — "does my scope already hold an identical
  non-archived doc, so I can link instead of duplicate".
- **Check:** exact match on `documents.content_hash == input.contentHash` (the
  **same sha256 hex** used everywhere; client hashes the file before upload),
  `archived_at IS NULL`, plus the **same agent record-scoping** as list/search.
- **Zero-leak:** runs in `withTenant` (RLS org isolation) → a hash that exists
  only in another org returns the same empty result as never-seen. Metadata only
  (no r2Key, no PII). Newest-first, hard-capped at `DEDUP_CANDIDATE_LIMIT = 20`.
- `hasDuplicate` derived strictly from candidate count (no drift).

**Rule count (Area 5): 1 content-hash exact-match rule (+ archived-exclusion + agent-scope + 20-cap modifiers).**

---

## Area 6 — CSV / EXCEL IMPORT rules (worker)

Sources: `apps/worker/src/mapping/mapping.ts`,
`apps/worker/src/mapping/mapping-resolver.ts`,
`apps/worker/src/validation/row-validator.ts`,
`apps/worker/src/parser/zip-preflight.ts`,
`apps/worker/src/parser/excel.parser.ts`,
`apps/worker/src/handlers/verify-job-payload.ts`.

### 6a. Header → canonical column MAPPING (`resolveMapping`, mapping.ts)
Verifying test: `mapping.spec.ts`.
- **Canonical fields:** `national_id`, `phone`, `name`, `apartment_number`,
  `building_address`, `ownership_pct`.
- **Required fields (must all map):** national_id, phone, name, apartment_number,
  building_address. (`ownership_pct` optional.)
- **Check:** each header is `normaliseHeader`'d (NFC, lowercase, strip ASCII
  whitespace+punctuation; keep Hebrew + `%`) then O(1) Set-looked-up against the
  per-field **ALIASES** registry (Hebrew + English synonyms — e.g. national_id:
  `תעודתזהות`,`תז`,`nationalid`,`id`,...; phone: `טלפון`,`נייד`,`phone`,`mobile`,...).
- **Errors:** missing required field → `mapping_incomplete`; one canonical mapped
  from two columns → `mapping_duplicate`; multi-match → `ambiguous`; no match →
  `unmapped`.

### 6b. Resolver chain L1/L2/L3 (`mapping-resolver.ts`)
Verifying tests: `mapping-resolver.spec.ts`, `template-resolver.spec.ts`.
- **L1 LegacyAliasResolver:** wraps `resolveMapping`. `mapping_incomplete` →
  `unknown` (defer); `mapping_duplicate` → `reject` (malformed file).
- **L2 TemplateResolver:** fingerprint = sha256 of normalised headers
  (`fingerprintHeaders`); looks up `mapping_templates` by `(orgId, fingerprint)`
  via `withTenant`, `archived_at IS NULL`. **Refuses** unapproved agent rows
  (`source='agent' AND approved_by IS NULL`); belt-and-suspenders `tpl.orgId ===
  ctx.orgId` re-check; validates the mapping jsonb shape + that all REQUIRED
  canonicals are numbers, else defers. (L3 AgentResolver not yet implemented.)
- **PII-in-header sanitisation (`sanitiseUserString`):** strips any run of **7+
  digits** (`\d{7,}` → `[N]`) from header strings before persisting to
  `import_jobs.parsed_headers` / `mapping_templates.name`/`.headers` (catches
  9-digit Israeli-ID shapes; the live in-memory headers keep cleartext for
  fingerprinting).

### 6c. Per-row VALIDATION (`validateRow`, row-validator.ts)
Verifying test: `row-validator.spec.ts`.
| Field | Rule | Error code |
|---|---|---|
| `national_id` | required, non-empty, **Israeli ID Luhn** (`isValidIsraeliId`) | `empty_required` / `invalid_luhn` |
| `national_id` | **in-file dedup** — normalised id (`padStart(9,'0')`) seen earlier in THIS import | `duplicate_national_id` |
| `phone` | required, non-empty, **Israeli E.164** (`normalizeIsraeliPhone` ≠ null) | `empty_required` / `invalid_phone` |
| `name` | required, non-empty, **≤ `NAME_MAX_LEN = 200`** chars | `empty_required` |
| `apartment_number` | required, non-empty | `empty_required` |
| `building_address` | required, non-empty | `empty_required` |
| `ownership_pct` | optional; if present must parse to a finite number **0..100** | `invalid_ownership_pct` |

- Luhn is validated **before** dedup (a malformed id is `invalid_luhn`, not a
  spurious dupe). PII (id/phone) is never logged — only structural error codes.

### 6d. ZIP / size PREFLIGHT (`zipPreflight`, zip-preflight.ts)
Verifying tests: `zip-preflight.spec.ts`, `zip-preflight-magic-bytes.spec.ts`.
- **Magic-byte gate (first):** byte 0 must be ZIP local-file-header
  `50 4B 03 04` **or** empty-EOCD `50 4B 05 06`; else
  `ExcelParserError('wrong_file_type')` (a non-xlsx upload — pdf/png/exe/text —
  is rejected with a meaningful error instead of a generic ExcelJS crash).
  Buffer < 4 bytes → `wrong_file_type`.
- **Zip-bomb gate:** parse the ZIP central directory, sum uncompressed sizes;
  total > **`MAX_DECOMPRESSED_BYTES = 50 MB`** → `decompressed_too_large`
  (fail-fast on running total). ZIP64 sentinel (`0xFFFFFFFF`) → rejected
  outright (a legit 50 MB xlsx never needs ZIP64).

### 6e. Excel parser guards (`excel.parser.ts`)
Verifying test: `excel.parser.csv-injection.spec.ts`.
- **CSV / formula-injection guard:** ExcelJS loaded with formulas disabled; the
  parser **REJECTS any file containing ANY formula cell** in the header row
  (`formula_in_header`) or any data row (`formula_in_data`). Formula cells are
  read as their `.result` value, never the formula text (injection vector).
- **Row-count safety:** > **`MAX_ROWS_SAFETY = 2_000_000`** rows →
  `ExcelParserError('corrupt_file')`.
- (Compressed-input cap of 50 MB is also enforced upstream at the presign /
  migration 0022 per the source comment.)

### 6f. Import-job payload tamper-verification (`verifyJobPayload`)
Verifying test: `verify-job-payload.spec.ts`.
- **Check:** read `(org_id, created_by)` directly from `import_jobs` via the
  BYPASSRLS `providerDb`, compare DB `org_id` to `payload.orgId`.
- **Rule:** mismatch → `JobPayloadTamperedError('org_mismatch')` (NonRetryable);
  row missing → `JobPayloadTamperedError('row_missing')`. The DB-attested values
  become the single source of truth for the rest of the handler (defense-in-depth
  against a poisoned producer payload).

**Rule count (Area 6): 1 mapping-resolution (6 fields / 5 required / N aliases) + 3 resolver-chain rules + 1 PII-header sanitiser + 7 per-row field rules + 2 zip-preflight gates + 2 parser guards + 1 payload-tamper rule ≈ 17 rules.**

---

## Area 7 — OTHER file/document rules (size/extension/retention/archive)

| Rule | What / basis | Source | Test |
|---|---|---|---|
| **Soft-delete / archive** | `archive()` sets `archivedAt` (NOT deletedAt), best-effort purges the R2 object, idempotent (already-archived → no-op) | documents.service.ts | (documents service specs) |
| **Agent record-scoping** | A doc is visible to an agent only if its parent project is an ACTIVE assignment (directly or via apartment→building→project); org-level docs are manager/viewer-only. Two correlated EXISTS (`agentDocScope`) | documents.service.ts | (documents service specs) |
| **Ghost / un-finalised gate** | Download requires `uploaded_at` set; else 409 `document_upload_incomplete` (only after visibility check — never an existence oracle) | documents.service.ts | (documents service specs) |
| **Name-search escaping** | `searchDocuments` escapes LIKE metachars (`\ % _`) and binds `q` as a parameter (literal substring, no injection) | documents.service.ts | (documents search specs) |
| **List size cap** | `ListDocumentsQuery.limit` Zod `min(1).max(100).default(25)` | shared-types/document.ts | — |
| **PATCH immutability** | `UpdateDocumentInput` allows only `name` + `type`; storage key/hash/size/parent immutable post-create | shared-types/document.ts | — |
| **Presigned-PUT byte binding** | Presign binds content-type + `min(sizeBytes, DOCUMENT_MAX_SIZE_BYTES)` ceiling | documents.service.ts | — |
| **No explicit retention/TTL deletion rule** | There is NO automatic time-based document-retention/purge job in the documents module (only event-driven purge on archive/reject). See Completeness note. | — | — |

---

## Verification basis

**Files read in full (source, not summaries):**
- `apps/api/src/modules/documents/document-classifier.ts`
- `apps/api/src/modules/documents/magic-bytes.ts`
- `apps/api/src/modules/documents/doc-encryption-registry.ts`
- `apps/api/src/modules/documents/documents.service.ts` (all 1808 lines)
- `apps/api/src/modules/projects/document-checklist.config.ts`
- `apps/worker/src/mapping/mapping.ts`
- `apps/worker/src/mapping/mapping-resolver.ts`
- `apps/worker/src/validation/row-validator.ts`
- `apps/worker/src/parser/zip-preflight.ts`
- `apps/worker/src/handlers/verify-job-payload.ts`
- `packages/db/src/providers/scan/scan.interface.ts`
- `packages/shared-types/src/document.ts` (constants/DTO sections)

**Grep sweeps performed (second pass for completeness):**
- size/byte ceilings: `DOCUMENT_MAX_SIZE_BYTES`, `MAX_*_BYTES`, `MAX_ROWS_SAFETY`,
  `MAX_DECOMPRESSED_BYTES`, `maxSizeBytes`, TTL constants.
- magic/signature/scan: `verifyMagicBytes`, `IFileScanProvider`, `verdict`,
  `ScanVerdict`, signature byte tables.
- import rules: `resolveMapping`, `validateRow`, `zipPreflight`,
  `verifyJobPayload`, `formula`/CSV-injection, `sanitiseUserString`.
- spec mapping: grepped each rule source's identifier across `*.spec.ts` in the
  api + worker trees to attach a verifying test.

**Spec files confirmed to exist and cover each area:**
`document-classifier.spec.ts` · `document-checklist.config.spec.ts` +
`projects-document-checklist.spec.ts` · `documents-magic-byte.spec.ts` ·
`doc-encryption-registry.spec.ts` (+ `doc-encryption-7d.spec.ts` referenced in
source) · `documents-dedup.spec.ts` + `documents-dedup-contract.spec.ts` ·
`mapping.spec.ts` · `mapping-resolver.spec.ts` + `template-resolver.spec.ts` ·
`row-validator.spec.ts` · `zip-preflight.spec.ts` +
`zip-preflight-magic-bytes.spec.ts` · `excel.parser.csv-injection.spec.ts` ·
`verify-job-payload.spec.ts`.

---

## Completeness statement (what I am SURE vs UNSURE about)

**SURE / fully source-verified:** every rule in Areas 1–6 was read line-by-line
from its source file, including exact regexes, byte signatures, thresholds
(0.85 remediation floor, 0.98 ceiling, 0.05 bonus, 50 MB caps, 200-char name,
2M-row, 9-digit Luhn / 7-digit sanitiser, 60-min PII TTL, 300/120s presign TTLs)
and each has a matching `*.spec.ts`.

**UNSURE / flagged for owner:**
1. **`doc-encryption-7d.spec.ts`** is *referenced by name in the service source*
   (the NO-AAD pin) but I did not open the spec file itself to confirm its exact
   assertions — the registry rules in `doc-encryption-registry.spec.ts` are
   confirmed, the envelope-format spec is asserted to exist by the source comment.
2. **Compressed-input 50 MB cap (migration 0022):** the worker source *comments*
   that a 50 MB *compressed* upload cap is enforced at the presign / migration
   0022 layer. I confirmed the *decompressed* 50 MB cap in `zip-preflight.ts`
   directly, but did NOT open migration 0022 / the import-presign code to verify
   the compressed cap value — treat that one number as comment-sourced.
3. **No time-based retention/auto-purge rule** exists in the documents module
   (purge is only event-driven: on archive, integrity-reject, scan-reject,
   type-mismatch). If the owner expects a scheduled document-retention rule, it
   is **not implemented** here — surfaced rather than omitted.
4. **L3 AgentResolver** (LLM-based header mapping) is documented in the resolver
   chain but **NOT yet implemented** (only L1 + L2 are live).
5. Rule **counts** are honest tallies of distinct checks; where a rule has
   sub-modifiers (e.g. dedup's archived-exclusion + agent-scope + cap) I counted
   the primary rule and listed modifiers inline rather than inflating the count.
