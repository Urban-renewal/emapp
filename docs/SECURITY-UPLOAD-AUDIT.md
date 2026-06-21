# Security Audit — Untrusted-File / Content-Security (Upload + Import Pipelines)

**Date:** 2026-06-18
**Scope:** `apps/api/src/modules/documents`, `apps/api/src/modules/imports`,
`apps/worker/src/parser`, `packages/db/src/providers/{storage,scan}`,
`apps/api/src/main.ts`.
**Posture under review:** "minefield" of malicious / infected uploads +
filename collisions, **without** hurting UX or load time.
**Method:** READ-ONLY source trace. Every claim below cites a real
`file:line`.

---

## TL;DR for the owner

The architecture is **strong**. The "contain by architecture, scan async"
model the owner wants is *already largely built*:

- **Collisions / traversal / overwrite: SOLVED.** Every storage key on every
  upload path is a server-minted `randomUUID()` partitioned per org. The
  user filename is display-only metadata; it never touches a path, a key, a
  shell, or (after sanitisation) a response header.
- **Malware scanning: REAL, async, fail-closed — but with a deployment
  caveat.** A working ClamAV (`clamd` INSTREAM) provider exists, the
  download gate is fail-closed on `scan_status='clean'`, and prod **refuses
  to boot** without a real scanner. `scanStatus` is **NOT** a dead stub.
  The honest gaps are: (a) the scan runs **inline in the finalize request**,
  not in the worker (a latency/availability concern, not a safety hole), and
  (b) the real ClamAV host has **not been verified wired in Infisical** yet —
  that is the one thing that must be confirmed before go-live.
- **Decompression bombs (xlsx import): SOLVED.** A hand-rolled ZIP
  central-directory pre-flight caps decompressed size at 50 MB *before*
  ExcelJS ever decompresses, ZIP64 is rejected, formula cells are rejected,
  and a row-count safety net exists. The parse runs in the **worker**, not
  the request.
- **The #1 real gap is TYPE SPOOFING on the documents path.** The
  document upload path trusts the **client-declared MIME** entirely — there
  is **no magic-byte verification**. An `.exe` (or an HTML file) declared as
  `application/pdf` is stored and later served with `Content-Type:
  application/pdf`. This is contained today by (a) the AV scan and (b) the
  separate R2 serving origin, but it is the highest-value cheap hardening
  available.

---

## Threat table

| # | Threat | Defended? | Evidence (`file:line`) | Gap |
|---|--------|-----------|------------------------|-----|
| 0 | **Key collision / overwrite / path traversal** (documents) | ✅ | `apps/api/src/modules/documents/storage.ts:190` `newDocumentKey` = `org/<orgId>/doc/<randomUUID()>`; r2Key never on the wire (`document.ts:13`, `documents.service.ts:183-201`) | none |
| 0 | **Key collision** (imports) | ✅ | `apps/api/src/modules/imports/imports.service.ts:149` `newImportKey` = `org/<orgId>/import/<randomUUID()>.xlsx` | none |
| 0 | **Filename used as key/path** | ✅ | filename stored as `name`/`fileName` metadata only; key is UUID. No `path.join(filename)`, no fs write of uploads anywhere | none |
| 1 | **Stored XSS / active content executing in victim browser** (SVG/HTML/PDF-JS/polyglot) | ✅ (defense-in-depth) | (a) MIME allow-list excludes `text/html` + `image/svg+xml` (`document.ts:46-58`); (b) download forced to `attachment` by default (`documents.service.ts:761`, `r2.provider.ts:110`); (c) served from **separate origin** `*.r2.cloudflarestorage.com`, not `app.emapp.io` (`main.ts:18-19,149`); (d) inline only for clean+allow-listed objects | ⚠ inline PDF preview is allowed (`disposition=inline`) — PDF-embedded JS *can* run in a PDF viewer, but on the R2 origin, not the app origin, so it can't touch app cookies/DOM. Acceptable; noted. |
| 2 | **Malware / infected file** | ✅ REAL scanner, async-ish, fail-closed | `clamav.provider.ts` (full `zINSTREAM` impl, fail-closed `parseReply:140`); gate `documents.service.ts:334` (`scan_status !== 'clean'` → reject) + `651 scanGate` archives+purges non-clean; prod fail-fast `scan-provider.factory.ts:42-50` | ⚠ scan runs **inline in `finalize`** (`documents.service.ts:638`), not a worker job → adds R2-read + clamd round-trip to the finalize request. ⚠ ClamAV host not confirmed provisioned in Infisical (factory only wires if `FILE_SCAN_CLAMAV_HOST` set). |
| 3 | **Type spoofing (declared MIME / extension ≠ real bytes)** — documents | ❌ | `documents.service.ts:373` stores `input.mimeType` verbatim; `getDownloadUrl` re-stamps it (`documents.controller.ts:116`). **No magic-byte check anywhere on the documents path** (grep for `file-type`/`magic`/`sniff` → only the import ZIP check + envelope magic) | **GAP.** Client-declared MIME is trusted end-to-end. |
| 3 | **Type spoofing** — imports (xlsx) | ✅ | `apps/worker/src/parser/zip-preflight.ts:99-108` rejects anything not starting with ZIP local-file-header magic `50 4B 03 04` | none |
| 4 | **Decompression / parse bomb (xlsx zip-bomb / billion-laughs)** | ✅ | `zip-preflight.ts`: parses CD, sums uncompressed sizes, caps at 50 MB (`MAX_DECOMPRESSED_BYTES:55`), **rejects ZIP64** (`:136`), fail-fast (`:144`); runs BEFORE `xlsx.load` (`excel.parser.ts:120,230`); row-count safety `MAX_ROWS_SAFETY=2_000_000` (`excel.parser.ts:89,150`); bounded stream read `MAX_INPUT_BYTES=52_428_800` (`excel.parser.ts:331-348`). Parse is in the **worker** (isolated from request) | none |
| 4 | **CSV / formula injection** (xlsx) | ✅ | formula cells rejected in header AND data rows (`excel.parser.ts:166,182,300` `rowHasFormula`); formula text never emitted (`stringifyCell:393` returns result, never formula) | none |
| 5 | **Size / resource (body limits)** | ✅ (per-route) | JSON routes keep Fastify 1 MB default; raw content route gets dedicated 50 MB ceiling **scoped to `application/octet-stream`** (`main.ts:116-120`, `documents.controller.ts:51`); presigned PUTs bound by `maxSizeBytes` (`documents.service.ts:447`, `imports.service.ts:505`); scan read bounded (`readObjectBytes:150`) | ⚠ presigned PUT `maxSizeBytes` is an S3 content-length-range *hint*; a Manager-minted URL still lets arbitrary bytes up to the cap be PUT (worker/scan catch the rest). |
| 6 | **Filename header injection (`\r\n` / `;` in Content-Disposition)** | ✅ | `safeDownloadFilename` (`storage.ts:207-226`) strips control chars, non-ASCII, `" \ / ; = ,`; Hebrew goes through the separate RFC 5987 `filename*=UTF-8''` slot via `encodeURIComponent` (`documents.controller.ts:114`) | none |
| 6 | **Filename → audit/wire PII leak** | ✅ | 7+ digit runs stripped (`imports.service.ts:190` `sanitiseFilenameForAudit`) on every persistence + wire boundary | none |
| - | **Inline as a fail-open AV bypass** | ✅ | gate fires before presign for BOTH dispositions (`documents-inline-disposition.spec.ts:207-242` I4/I5) | none |
| - | **Sensitive-doc bytes at rest** | ✅ | sensitive docs never get a presigned PUT; flow through API content path, scanned as plaintext, stored AES-256-GCM `EMAPPENC` envelope, decrypt-streamed (`documents.service.ts:866-996,1037-1095`) | none |
| - | **External tier (contractor/resident) serving** | ✅ | contractor download gated on `scan_status='clean'` AND `sensitive=false`, IDOR-checked, default attachment (`contractor-read.service.ts:217-260`) | none |

Legend: ✅ defended · ⚠ defended but with a caveat / residual risk · ❌ gap.

---

## Confirmations the owner asked for (verified, not assumed)

**1. UUID keys on ALL upload paths.** Confirmed for the two upload paths that
exist:
- documents: `newDocumentKey(orgId)` → `org/<orgId>/doc/<randomUUID()>`
  (`storage.ts:190-192`).
- imports: `newImportKey(orgId)` → `org/<orgId>/import/<randomUUID()>.xlsx`
  (`imports.service.ts:149-151`).
- **There is no avatar / logo / profile-image upload path.** The
  `avatar`/`logo`/`presign` grep hits in `auth`/`members`/`portal` are *not*
  uploads (they are profile reads, gravatar-style URL fields, or unrelated
  presence of the word). The only two byte-accepting surfaces are documents
  and imports. The user filename is **display metadata only** on both — it is
  never used to build a key, a filesystem path, or a shell argument.

**2. `scanStatus` is REAL, not a stub.** This was the owner's key question.
Traced end-to-end:
- **Who sets it:** `DocumentsService.scanGate` (`documents.service.ts:651`)
  and `uploadContent` (`:930`) call the injected `IFileScanProvider.scan()`
  and persist the verdict. `clean` → `scan_status='clean'` (`:679`);
  anything else → `scan_status` = `infected`/`error`, row archived, object
  purged (`recordScanReject:717`).
- **pending → clean/infected transition:** finalize commits the row with
  `scan_status='pending'` (`:594-596`), then runs `scanGate` **after commit**
  (`:638`). So there is a real `pending` window where the doc is **not
  servable**.
- **Download gate:** `loadVisible(..., requireUploaded=true)` throws
  `SCAN_REJECTED` unless `scan_status==='clean'` (`:334`). The download/
  decrypt-stream/contractor paths all pass `requireUploaded=true` or filter
  `scan_status='clean'` in SQL. **A pending or infected doc cannot be
  downloaded.** Proven by `documents-inline-disposition.spec.ts` I4/I5 and
  `documents-scan-gate.spec.ts`.
- **The scanner is real:** `ClamAvFileScanProvider`
  (`packages/db/src/providers/scan/clamav.provider.ts`) is a complete clamd
  `zINSTREAM` client with fail-closed parsing. `scanProviderFactory`
  (`scan-provider.factory.ts:31`) wires it whenever `FILE_SCAN_CLAMAV_HOST`
  is set (any env) and **throws at boot in production** if it is not
  (`:42-50`) — so prod can never silently run the `Noop` (always-clean)
  scanner.

  **Caveat to verify before go-live:** the Noop scanner is the dev/test
  default, and the *only* thing that flips prod to the real one is the
  presence of `FILE_SCAN_CLAMAV_HOST` (+ a reachable `clamd`). Confirm that
  secret + service are actually provisioned in Infisical/Railway; the boot
  guard protects you (it fails loud) but the scanner is only as real as the
  host you point it at, and `StreamMaxLength` on the daemon must be ≥ 50 MB
  (noted in `clamav.provider.ts:32-38`).

**3. Safe serving.** Confirmed:
- Default `Content-Disposition: attachment` (`documents.service.ts:761`,
  `r2.provider.ts:110`); `inline` is opt-in and only ever applied to a
  clean, allow-listed object.
- The MIME **allow-list excludes `text/html` and `image/svg+xml`**
  (`document.ts:45-58`) — the two classic stored-XSS vectors — so inline
  can't serve script-bearing markup from the allow-listed set.
- **Origin separation:** documents are served from
  `*.r2.cloudflarestorage.com` via short-lived presigned URLs, a **different
  origin** from the app (`app.emapp.io`, `main.ts:18`). Even if a polyglot
  HTML slipped the allow-list and were served inline, it would execute in
  the R2 origin's sandbox — no access to app cookies, app DOM, or the app's
  CSP context. This is the strongest structural defense and it is in place.

---

## Prioritized hardening plan

Ordered to maximise safety per unit of UX/latency cost. The model is exactly
the owner's: **cheap synchronous checks at the door, real scan async,
structural safe-serving** (already done).

### P0 — confirm the AV scanner is actually wired (ops, ~0 code)
The single highest-leverage action. Verify in Infisical/Railway that
`FILE_SCAN_CLAMAV_HOST` (+ `_PORT`) points at a running `clamd` reachable
from the API, and that the daemon's `StreamMaxLength` ≥ 50 MB. The boot
guard (`scan-provider.factory.ts:42`) already prevents a prod deploy with
*no* host, but it cannot tell you the host you set is healthy. Add a
deploy-time smoke (upload an EICAR test string → expect 409
`document_scan_rejected`) to prove the wire end-to-end. **No code, no UX
cost.**

### P1 — magic-byte verification on the documents path (cheap, synchronous)
Close threat #3. Today the documents path trusts the client MIME. Add a
small magic-byte sniff (the first ~16 bytes) on the **finalize** path (where
the server already reads the object for the scan) and on the **content**
path (where the server already holds the plaintext buffer). Reject when the
sniffed type is incompatible with the declared `mimeType` allow-list entry
(e.g. declared `application/pdf` but bytes aren't `%PDF`; declared
`image/png` but no PNG signature). This mirrors what the import path already
does in `zip-preflight.ts`.
- **Where:** `documents.service.ts` `scanGate` (already has the bytes via
  `readObjectBytes`) and `uploadContent` (already has `body: Buffer`).
- **Cost:** a few microseconds on a buffer already in memory. **Zero extra
  I/O, zero UX change** for legitimate files.
- **Why it matters even with AV:** ClamAV catches *known malware*, not a
  *renamed-but-benign-looking* executable or a polyglot; magic-byte +
  allow-list is the type-confusion defense AV doesn't provide.

### P2 — move the document AV scan into the worker (latency + availability)
Currently the scan is inline in the `finalize` request
(`documents.service.ts:638`): the user's finalize call blocks on an R2 read
+ a clamd round-trip (up to the 30 s clamd timeout). This is a **UX/load**
concern, not a safety one (the gate is already fail-closed). The import
pipeline already demonstrates the right pattern: enqueue a pg-boss job
(`imports.service.ts:775`), let the worker do the heavy I/O, gate
downloads on the persisted verdict.
- **Design:** finalize commits `scan_status='pending'` (it already does) and
  enqueues a `document_scan` job instead of calling `scanGate` inline. The
  worker reads the object, scans, and flips the row to `clean` or archives
  it. The download gate is unchanged (it already refuses non-`clean`), so the
  pending window is already safe.
- **Benefit:** finalize returns instantly; clamd slowness/outage can't 503
  the user's upload; scans become retryable and observable like imports.
- **Trade-off:** a short delay between finalize and first downloadable —
  acceptable and already the implicit contract (the `pending` state exists).

### P3 — tighten residual edges (low)
- **Inline PDF JS:** `disposition=inline` lets a PDF render in-browser; a
  PDF can carry JS that some viewers execute. It runs on the R2 origin (no
  app access), so risk is low. If the owner wants belt-and-suspenders,
  restrict `inline` to `image/*` + keep `application/pdf` as `attachment`,
  or add `Content-Security-Policy: sandbox` / `X-Content-Type-Options:
  nosniff` to the R2 response headers (R2 supports response-header
  overrides on the presign).
- **`X-Content-Type-Options: nosniff`** is not currently stamped on the
  presigned download responses. Adding `ResponseContentType` is already
  done; adding `nosniff` via the presign stops browser MIME-sniffing of a
  spoofed object (defense-in-depth alongside P1).
- **Presigned-PUT byte ceiling is a hint, not a hard wall** for a
  Manager-minted import URL — the worker's `zipPreflight` + bounded read are
  the real wall, which is correct, but worth knowing the PUT itself isn't a
  strict gate.

---

## What is explicitly NOT a gap (so it doesn't get "fixed" by mistake)
- The `pending` scan window is intentional and safe — downloads are gated.
- The Noop scanner returning `clean` in dev/test is intentional; prod
  fail-fast prevents it shipping.
- Storing the cleartext filename in the DB column (while sanitising the wire
  + audit) is intentional (uploader UX + forensics via BYPASSRLS pool) —
  `imports.service.ts:120-127`.
- ZIP64 rejection in the xlsx preflight is intentional (a 50 MB xlsx never
  needs it) — not a compatibility bug.
