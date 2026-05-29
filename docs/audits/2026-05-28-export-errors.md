# V11 Export endpoints — error-handling audit (2026-05-28)

Scope: `GET /api/v1/projects/:id/export?format=xlsx|pdf` and its
collaborators in `apps/api/src/modules/export/`. Read-only review.

Lens mirrors the Manager-BE errors-audit: D.16 envelope, status-code
correctness, audit trail, PDF/xlsx failure modes, pool exhaustion,
PII leakage, cancellation, logging hygiene.

---

# CRITICAL

## E-C1 — `project.export` audit row is silently lost when the renderer fails

Site: `export.controller.ts:75-79`, `export-composer.service.ts:288-297`

What goes wrong: the audit row is written _inside_ the composer's
`withTenant` tx (`export-composer.service.ts:288`) and committed when
the composer resolves at L302. The renderer call
(`pdf.renderProjectPdf` / `xlsx.renderProjectXlsx`) runs _after_ the
tx has committed (`export.controller.ts:77-79`). If the renderer then
throws (Chromium crash, ExcelJS OOM, font lookup failure — see
E-C4/E-H3/E-M1), the audit log records a successful export that
never actually delivered bytes — and conversely, the user's PII
_has_ been decrypted into process memory and may have been partially
written to the response socket before the throw. Forensic story is
inverted: "audit says yes, user got 500" is indistinguishable from
"audit says yes, user got the file".

What the user sees: 500 with `{ error: { code: "500", message: "Internal server error" } }` (per `http-exception.filter.ts:116`).

What should happen: write the audit row with an `outcome` field
(`started` before render, `delivered`/`failed` after) — OR keep a
single row but defer it until after the renderer succeeds. The "same
tx as the read" comment at `export-composer.service.ts:54-56` is no
longer accurate to the actual control flow.

Fix recommendation: split audit into a pre-flight `project.export.requested` (committed in composer tx) and a post-render `project.export.delivered` (committed in a fresh withTenant tx after `pdf.pdf()` returns). Track A's existing audit conventions in `AuditService` already support multi-action sequences.

## E-C2 — Decrypted PII in process memory survives renderer throw / client cancel

Site: `export-composer.service.ts:219-236` (decrypted cleartext) →
`export.controller.ts:75-79` (passed to renderer); `pdf-export.service.ts:95-133`.

What goes wrong: `decryptOwnerPiiBatch` produces an array of
cleartext `{ name, nationalId, phone }` tuples. These flow through
`composedBuildings` (`export-composer.service.ts:270-277`) into the
renderer. If the controller throws between L75 and the final
`return buf` (L107) — Chromium hang, browser.close error, Buffer
allocation OOM — the `input` object referenced by the running async
frame remains live until the GC cycle. Combined with E-H1
(client-disconnect): the PII may linger in heap while the request is
already abandoned, and any subsequent heap dump for forensics
exposes every owner national_id in cleartext.

What the user sees: 500.

What should happen: zero out / explicitly drop cleartext refs in a
`finally` block after the renderer returns. At minimum, the
controller should not hold the input alive longer than necessary —
currently `input` stays in scope through the entire header-write
sequence (L86-105) for filename derivation, which is unnecessary
(filename only needs `project.name`).

Fix recommendation: hoist `projectName` into a local at L86 immediately and `input = null as any` after the renderer returns, so the GC can reclaim the PII array before the response headers/buffer are flushed. Long term: a `ScopedPii` wrapper with explicit `.dispose()` that overwrites the underlying strings.

## E-C3 — Composer-side throws leak the D.16 envelope into the exception's `response.error` field, which the filter strips

Site: `export-composer.service.ts:111-113`, `:122-124`.

What goes wrong: the composer throws `new NotFoundException({ error: { code: 'not_found' } })`. NestJS treats the argument as the _full_ response body. The global filter at `http-exception.filter.ts:75-87` then inspects `body.error`; because `errVal` is the object `{ code: 'not_found' }`, the body is passed through unchanged. _However_, the body that reaches the wire is `{ error: { code: 'not_found' } }` with **no `message` field** — which violates the D.16 envelope shape declared in CLAUDE.md ("Errors: `{ error: { code, message, details? } }`"). `message` is documented as required, not optional. All four explicit throws in this module omit it (`export.controller.ts:72`, `export-composer.service.ts:112`, `:123`).

What the user sees: `{"error":{"code":"not_found"}}` — code present, message absent.

What should happen: include a human-readable `message` per D.16.

Fix recommendation: standardise on `throw new NotFoundException({ error: { code: 'not_found', message: 'project not found' } })`. Same for the `forbidden` throw at controller L72.

---

# HIGH

## E-H1 — Client disconnect mid-PDF leaves Chromium page+context open until `page.pdf()` resolves

Site: `pdf-export.service.ts:95-133`.

What goes wrong: there is no `req.raw.on('close', ...)` handler. If the user navigates away while `page.pdf()` is running, the request socket is gone but the Promise keeps running; the browser only closes in the `finally` at L130-132 _after_ the PDF buffer has been fully serialised. For a 1000-row project (45 s budget per Doc 03 §11), that's up to 45 s of locked Chromium per cancelled request. A bored user hammering Ctrl+R could DoS the API in minutes — Track B has only one Chromium binary and serial export semantics.

What the user sees: nothing on the cancelled request; subsequent requests sit in throttler queue or fail with pool exhaustion (E-H2).

What should happen: subscribe to `reply.raw.on('close')` and call `page.close({ runBeforeUnload: false })` + `browser.close()` on early termination; check `page.isClosed()` before reading `page.pdf()`.

## E-H2 — Composer holds a withTenant tx for the entire decrypt + audit window; large projects can exhaust the Neon pool

Site: `export-composer.service.ts:68-302`.

What goes wrong: the _whole_ compose flow — project lookup, generator lookup, buildings, apartments, ownerships, 3 batched decrypts, in-memory shape, audit insert — runs inside a single `withTenant` tx. `decryptOwnerPiiBatch` is described as 3 round-trips at ~50ms each, but for a worst-case 5000-owner project that's ~750ms plus the in-memory grouping (~250ms more), all holding a Neon pool slot. 10 concurrent exports (the throttle is per-user, not global) → pool exhaustion → every other API request 500s. This compounds E-H1: stuck Chromium → stuck tx → stuck pool.

What the user sees: unrelated endpoints return 500 with `{ error: { code: "500" } }`.

What should happen: keep the project + generator + raw row reads inside withTenant, but move the in-memory grouping/shaping (`export-composer.service.ts:239-285`) _outside_ the tx. The audit row write should be its own short tx.

## E-H3 — Bare `Error` from font-resolution path bypasses D.16 normalisation cleanly but its message leaks `process.cwd()`

Site: `pdf-export.service.ts:196-201`.

What goes wrong: `throw new Error(`pdf-export: could not locate @fontsource/heebo files. CWD=${cwd}. Tried: ${candidates.join(' | ')}. ...`)`. A plain `Error` (no statusCode, no HttpException) → filter falls through to the 500 branch (`http-exception.filter.ts:49-72, 116-122`) → logs the full message at `error` level (L50-52). The body is the generic envelope but the **server logs** record the absolute Railway container path and the resolved node_modules layout. Operationally this is a deployment fingerprint that should not be in logs flagged by Sentry.

What the user sees: 500 with `{ error: { code: "500", message: "Internal server error" } }` — clean.

What should happen: convert to a typed `InternalServerErrorException({ error: { code: 'pdf_font_missing', message: 'export unavailable' } })` and log the cwd/candidates separately with `logger.error({ cwd, candidates }, 'pdf font missing')` so it can be redacted upstream.

## E-H4 — `chromium.launch` failure produces a 500 with no operator hint and orphans no resources (only because no resources were acquired) — but no retry, no circuit breaker

Site: `pdf-export.service.ts:98, 135-141`.

What goes wrong: if `chromium.launch` rejects (binary missing, missing system deps on a fresh Railway container, sandbox failure, port collision on test runners), the throw propagates as a plain `Error` → 500. The same Railway container will keep returning 500 for every PDF request until the binary is repaired — no early "PDF unavailable, try xlsx" hint to the FE, no health-check awareness.

What the user sees: 500 with the generic `Internal server error` envelope; the existing `format=xlsx` path still works but the FE has no way to know to fall back.

What should happen: wrap launch in a `ServiceUnavailableException({ error: { code: 'pdf_unavailable', message: '...' } })` so the FE can fall back to xlsx, and add a startup readiness probe that fails fast if chromium can't launch.

---

# MEDIUM

## E-M1 — `Content-Length` is computed from the buffer but `Cache-Control: no-store` does not stop CDN buffering of partial bodies

Site: `export.controller.ts:98-105`.

What goes wrong: not a code defect, but: the response is fully buffered (`buf.byteLength`) before headers are written, so a renderer mid-stream failure (ExcelJS throwing during `wb.xlsx.writeBuffer()` at `export.service.ts:246`) means the user gets a clean 500 _without_ a partial download — good. But if a future change switches to a streaming writer (the comment at L40-43 anticipates this), the partial-stream failure mode is undefined. Worth documenting that the current 1000-row in-memory budget is what guarantees atomic success/failure.

What the user sees: today, clean 500 on render failure. Tomorrow (stream): truncated xlsx with no error indicator.

What should happen: add a comment block tying the in-memory writer choice to the "no partial download" guarantee and require the streaming-writer follow-up to ship with a trailer/abort mechanism.

## E-M2 — Throttle hit returns NestJS Throttler default 429, which is _not_ a D.16 envelope

Site: `export.controller.ts:59` (`@Throttle({ default: { limit: 10, ttl: 3_600_000 } })`).

What goes wrong: NestJS's `ThrottlerGuard` throws `ThrottlerException` whose response body is `{ statusCode: 429, message: 'ThrottlerException: Too Many Requests' }`. The global filter at `http-exception.filter.ts:75-103` will hit the "not D.16-shaped" fallback at L100-102 and emit `{ error: { code: 'http_429' } }` — which is _technically_ D.16-shaped but loses the rate-limit semantic. No `Retry-After` header is set.

What the user sees: `{ error: { code: 'http_429' } }`, no Retry-After.

What should happen: a project-wide ThrottlerException filter (if not already present elsewhere) — out of scope to fix here, but the export endpoint should add a code like `rate_limited` and emit the `Retry-After` header.

## E-M3 — Audit row's `afterState.rowCount` is 0 for empty projects but the audit row still claims success — operators can't distinguish "ran on empty project" from "filter excluded everything"

Site: `export-composer.service.ts:147-156`, `:285`, `:288-297`.

What goes wrong: a manager exporting an empty project, a manager exporting a populated project where every owner is archived, and a manager exporting a project with one apartment and zero owners all land as `afterState: { format, rowCount: 0 }`. Forensically these are different situations (nothing-to-disclose vs filter-suppressed PII vs gap).

What the user sees: 200 + an empty/sparse file (correct).

What should happen: include `buildingCount`, `apartmentCount`, `ownerCount` separately in `afterState` so post-incident review can answer "did this user see PII this time?" with one row.

## E-M4 — Format-validation error message is technically D.16 but the `details` shape leaks field paths that hint at internal pipe construction

Site: `export.controller.ts:65` + `zod-validation.pipe.ts:53-58`.

What goes wrong: `?format=invalid` → `BadRequestException({ error: { code: 'validation_error', details: result.error.flatten().fieldErrors } })` → body `{ error: { code: 'validation_error', details: { format: ['Invalid enum value...'] } } }`. Fine for `format`; for `:id` (UUID pipe) the value being parsed is a bare string, so `fieldErrors` is empty and a generic `{ _: [...] }` may surface. Minor inconsistency between the two pipe call sites at L64 and L65 — `:id` validation failure looks structurally different from `?format` validation failure.

What the user sees: shape-inconsistent 400s.

What should happen: wrap both with a single param schema or normalise the `details` shape.

## E-M5 — `console.log`-equivalent: composer logs the project id on every successful export

Site: `export-composer.service.ts:303-305`, `export.service.ts:247-249`, `pdf-export.service.ts:124-126`.

What goes wrong: `this.logger.log('composed project ${projectId} → ...')`. Project ID is not PII (it's a UUID, no owner data), so this is OK per CLAUDE.md. But the same project ID + the actor in the upstream `RequestContext` (if logged in adjacent middleware) creates a join key for "who exported what when" in logs — duplicating the audit log. Verify this isn't double-logged to an aggregator that has weaker access controls than the DB.

What the user sees: nothing.

What should happen: confirm the logger output goes only to Railway logs (which are operator-only), not to a 3P aggregator. No PII (owner names/national_ids) leak — verified at `export.service.ts:248` (only row count + elapsed) and `pdf-export.service.ts:125` (project id + byte size + ms). Good hygiene; doc the policy.

---

# LOW

## E-L1 — `void and` and `void _drop` at `export-composer.service.ts:248, 311` are lint-noise indicators of pattern that future refactors will misread

Site: `export-composer.service.ts:248`, `:311`.

What goes wrong: smells, not bugs. The `void _drop` at L248 is a workaround for tsc unused-var; the `void and` at L311 is dead-on-arrival (no longer needed after the agent-branch was added at L80-110, which uses `and`).

Fix recommendation: drop both; use `_` prefix convention.

## E-L2 — `ExportService.renderProjectXlsx` writes Manager's _name_ into `wb.creator` (workbook metadata)

Site: `export.service.ts:167`.

What goes wrong: `wb.creator = `EMAPP — ${input.generatedBy.name}``writes the Manager's display name into the .xlsx core properties. CLAUDE.md treats`national_id`/`phone`/`signatures` as PII; user _names_ of org members are not enumerated as PII. Still, embedding an operator's identity in a downloadable artifact may matter for the partner's leak posture (a tenant who is sent the file later sees who produced it). The comment at L170-173 acknowledges this is intentional (D.17 audit posture).

What the user sees: their name in the .xlsx Properties dialog.

Fix recommendation: confirm D.17 explicitly allows operator-name in exported metadata.

## E-L3 — `dataRowCount` in PDF service silently disagrees with composer's `rowCount`

Site: `pdf-export.service.ts:143-151` vs `export-composer.service.ts:285`.

What goes wrong: composer computes `rowCount = decryptedOwners.length || aptRows.length` (L285); PDF computes `n += Math.max(1, apt.owners.length)` (`pdf-export.service.ts:147`). For a project with one apartment + zero owners, composer reports `rowCount=1`; PDF logger reports `dataRows=1`. For zero apartments, composer reports `0`, PDF reports `0`. Aligned today, but the two formulas could drift. Audit log uses composer's number.

Fix recommendation: have the PDF service receive the row count from the composer (already returned) instead of recomputing.

---

# Clean checks

- **Controller guard stack** (`export.controller.ts:48`): `AuthGuard + TenantGuard + AuthorizationGuard` in correct order; matches the rest of the API.
- **UUID pipe rejects non-UUIDs** (`export.controller.ts:18, 64`): a non-UUID `:id` is caught at the pipe and rendered as `validation_error` 400 — not as a Postgres parse error.
- **RLS scope** (`export-composer.service.ts:68-302`): every read inside `withTenant(user.orgId, ...)`; no bare `db.query` calls. Cross-org test at `export.s10.spec.ts:286-290` exercises the gate.
- **Agent scope-to-assigned** (`export-composer.service.ts:80-99`): INNER JOIN on `project_assignments` with `isNull(unassignedAt)` — matches `ProjectsService.get()` posture. Positive + negative tests at `export.s10.spec.ts:292-369`.
- **Soft-delete filters** (`export-composer.service.ts:136, 176, 200`): `archivedAt IS NULL` on buildings/apartments/owners; `endedAt IS NULL` on ownerships. Tested at `export.s10.spec.ts:371-380`.
- **PII never logged at the renderer boundary** (`export.service.ts:247-249`, `pdf-export.service.ts:124-126`): only row count + elapsed ms + project id + byte size. No owner names, no national_ids.
- **Hebrew-safe filename** (`export.controller.ts:88-91, 123-137`): RFC 5987 `filename*=UTF-8''…` + ASCII slug fallback that strips control chars (CR/LF/NUL — no header injection).
- **No-store cache header + nosniff** (`export.controller.ts:103-105`): correct for binary PII downloads.
- **Throttle declared** (`export.controller.ts:59`): 10/hour per user — matches Doc 03 §11.
- **Decryption batched** (`export-composer.service.ts:219-222`): one round-trip per PII column, not per owner — avoids N+1 timing oracle.
- **Format query default** (`export.controller.ts:19`): omitted `format` defaults to xlsx (not 400) — explicit by design.
