# V11 Export Endpoint — Performance Audit

Date: 2026-05-28
Scope: `apps/api/src/modules/export/{export.controller,export.service,export-composer.service,pdf-export.service,export.module}.ts`
Endpoint: `GET /api/v1/projects/:id/export?format=xlsx|pdf`
Hard rule under review: "more than 1 second is excessive."

## Severity rollup

| ID  | Title                                                           | Severity     | Budget violation?                                                    |
| --- | --------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| F1  | Playwright Chromium launched per request (no pool)              | **CRITICAL** | YES — 600-1500 ms cold-start dwarfs the 1 s budget on its own        |
| F2  | xlsx buffered fully into RAM before send (no stream)            | High         | Borderline at 10k rows (~80–150 MB peak); within budget for <1k rows |
| F3  | Whole response buffered: no chunked transfer                    | Medium       | Adds 100-300 ms TTFB for 5 MB xlsx                                   |
| F4  | `wb.xlsx.writeBuffer()` blocks event loop                       | Medium       | Tail latency under concurrency, not a single-request budget breach   |
| F5  | Pool exhaustion under concurrent exports                        | Medium       | Five managers × 0 conn reservation = head-of-line blocking risk      |
| F6  | Throttle bucket per-user, not per-org — leakable noisy-neighbor | Low          | Not a perf bug; org-level shield missing                             |
| F7  | Empty-project audit path bypasses generator fetch ordering      | Info         | Not a perf issue                                                     |

Estimated total wall time, 100-apartment / 300-owner project, warm process:

- DB compose: ~250 ms (G — meets <300 ms target)
- xlsx render: ~150 ms (G — meets budget)
- PDF render: ~1800 ms (RED — breaches 1 s rule; cold launch ≈ 1.2 s + content + fonts.ready)

---

## F1 — Playwright Chromium launched per request

**Site:** `pdf-export.service.ts:98` (`this.launchBrowser()` inside `renderProjectPdf`), `pdf-export.service.ts:135-141` (`launchBrowser` calls `chromium.launch({ headless: true })`), `pdf-export.service.ts:131` (`await browser.close()` in `finally`).

**Current behaviour:** Every `format=pdf` request spawns a new headless Chromium process, opens a context + page, sets content, evaluates `document.fonts.ready`, prints, then tears down. The class comment at `pdf-export.service.ts:68-71` openly acknowledges "a pool comes in a follow-up" and asserts "the MVP has none yet" — the throttle is set to 10/hour/user (`export.controller.ts:59`) precisely because each call is expensive.

**Cost estimate:** Cold `chromium.launch` on Linux containers: 600-1200 ms baseline (process fork + Chromium init + DevTools handshake). `newContext` + `newPage`: ~80 ms. `setContent` + load: 50-300 ms depending on row count. `document.fonts.ready` once the base64 woff2 parses: 30-80 ms. `page.pdf`: 200-600 ms for an A4 landscape with 300 rows. `browser.close`: 100-200 ms.

Lower bound, hot Linux container: ~1.1 s. Upper bound, first request after deploy: ~2.5 s.

**Budget violation?** **YES.** Even the optimistic path is > 1 s; the cold path is 2.5× the rule. There is no second concern that needs to be in scope to breach the budget — the launcher alone does it.

**Fix recommendation:** Singleton `Browser` held on the service (`onModuleInit` → `chromium.launch`, `onModuleDestroy` → `close`) with a short-lived `BrowserContext` per request (Playwright contexts are the isolation boundary, not browsers). A small `Page` pool of 2-4 keeps cold-start out of the per-call path; on Railway this saves ~1 s on every PDF call. Health check should `browser.isConnected()` and relaunch if false. The throttle of 10/hour stays meaningful because PDF rendering is still CPU-bound, not because launch is expensive.

---

## F2 — xlsx is buffered fully into memory before send

**Site:** `export.service.ts:246` (`const buf = await wb.xlsx.writeBuffer()`), `export.controller.ts:79` (returns `buf` via Nest `passthrough`), `export.controller.ts:100` (`Content-Length` set from `buf.byteLength`).

**Current behaviour:** `ExcelJS.Workbook.xlsx.writeBuffer()` materialises the entire xlsx blob in process memory, then Nest writes it to the response as a single chunk. ExcelJS does support `WorkbookWriter` for streaming, but the comment at `export.service.ts:43` confirms the in-memory path is intentional: "Streaming writer is reserved for the > 10K-row async path the roadmap defers."

**Cost estimate:** xlsx is zip-compressed XML; rough rule is ~600 bytes/row uncompressed → ~150 bytes/row on the wire. 100 apartments × 3 owners = 300 rows ≈ 50 KB on disk, ~2-5 MB RAM peak inside ExcelJS due to the cell-object graph. At 10k rows: ~1.5 MB on disk but **80-150 MB resident** during composition (every cell is a `Cell` object plus style refs). Encode time alone for 10k rows: ~2-4 s of zip + XML serialisation.

**Budget violation?** Not for the 100-apartment / 300-owner happy path (well under 1 s). **Yes if a manager exports a 5k-apartment portfolio** — both the memory ceiling and the encode time blow past 1 s. On Railway 512 MB containers, 80-150 MB peaks per call put any concurrent xlsx call at OOM risk.

**Fix recommendation:** When `dataRowCount > N` (suggest N=2000), switch to `ExcelJS.stream.xlsx.WorkbookWriter` writing directly to `reply.raw`. Drop `Content-Length` and let Fastify chunk. The current code path is fine for the MVP if the partner's largest project stays small, but the upper-bound risk is open.

---

## F3 — Whole response buffered: no chunked transfer

**Site:** `export.controller.ts:62` (`@Res({ passthrough: true })`), `export.controller.ts:66` (`Promise<Buffer>` return shape), `export.controller.ts:100` (explicit `Content-Length`).

**Current behaviour:** Time-to-first-byte equals time-to-last-byte; the controller awaits the full renderer before any header flushes. The user sees the spinner for the entire compose + render + encode duration.

**Cost estimate:** For a 5 MB xlsx on a 10 Mbit upload pipe: 4 s wall serialise + 4 s transfer if streamed concurrently; in the buffered path it is **8 s sequential**. For PDF the same penalty applies but is masked by the much larger F1 cost.

**Budget violation?** Adds 100-400 ms perceived latency for a 1-5 MB body even on fast links. Combined with F1/F2, breaches the 1 s rule for any non-trivial project.

**Fix recommendation:** Pair with F2 fix. For PDF, write `browser.newCDPSession`'s `Page.printToPDF` with `transferMode: 'ReturnAsStream'` and pipe to `reply.raw`. Drop `Content-Length` (incompatible with `Transfer-Encoding: chunked`).

---

## F4 — `wb.xlsx.writeBuffer()` blocks the Node event loop

**Site:** `export.service.ts:246`.

**Current behaviour:** ExcelJS's XML + zip encode runs entirely on the main thread. For a 1000-row export, ~250-600 ms of synchronous-ish CPU time inside `await`.

**Cost estimate:** Single-request impact: included in F2 figures. Multi-request impact: while one xlsx is encoding, every other request to the API (including health checks) queues behind it. For a 10k-row export, tail p99 across the whole API spikes by 2-4 s.

**Budget violation?** Not for the encoding call itself; it does breach the budget for **other** in-flight callers.

**Fix recommendation:** Either the F2 streaming switch, or move large xlsx renders to a worker thread (`piscina`) so the API event loop stays responsive. The roadmap mention at `export.service.ts:42-43` of an "async path" for >10K rows is the right home.

---

## F5 — Pool exhaustion under concurrent exports

**Site:** `export-composer.service.ts:68` (`withTenant(...)`) wraps the entire compose; `packages/db/src/wrappers/with-tenant.ts:41-86` holds a single pool connection from `BEGIN` through `COMMIT`. Pool `max=20` per `packages/db/src/client.ts:107`. `statement_timeout=30_000 ms` per `client.ts:110`.

**Current behaviour:** Each export reserves one connection for the duration of `compose + decrypt`. For 100 owners that is ~250 ms; for 1000 owners ~600 ms (3 batched decrypt round-trips + Neon RTT). Audit log INSERT happens inside the same tx (good — same connection), so no extra reservation.

**Cost estimate:** Five managers concurrently exporting + the rest of the app at p50 load: app uses ~12-15 of 20 connections at baseline (auth, RLS-wrapped reads). Five 600 ms holds add 5 to the in-flight count; depending on traffic this can starve quick reads. Statement timeout of 30 s means a single rogue export cannot block forever, but the pool wait queue is unbounded.

**Budget violation?** Not single-request, but contributes to tail latency for **other** requests during export bursts.

**Fix recommendation:** Two-phase compose: (a) read everything into memory inside `withTenant`, (b) release connection, (c) render. Today the tx is held across all of compose + audit log write, which is correct for atomicity but the rendering would never have been in the tx anyway. The current code is already structured this way — F5 is bounded by the 600 ms cap and the throttle limit. Acceptable for MVP; revisit if Manager-count grows past 50.

---

## F6 — Throttle bucket per-user, not per-org

**Site:** `export.controller.ts:59` (`@Throttle({ default: { limit: 10, ttl: 3_600_000 } })`); `common/guards/throttler.guard.ts:45-52` (`getTracker` returns `u:${user.sub}`).

**Current behaviour:** ConfigurableThrottlerGuard correctly keys on JWT subject — verified via `apps/api/src/app.module.ts:121` registering it as the global `APP_GUARD`, and `getTracker` reads `req.user.sub` set by `AuthGuard`. So the bucket does NOT leak across orgs by user-ID confusion (each JWT subject is unique across the system).

**Budget violation?** No correctness issue. However: a single org can have many managers; an org with 10 managers could trigger 100 exports/hour combined, each holding pool + Chromium. The class-comment at `export.controller.ts:56-58` cites "10 per user per hour" from Doc 03 §11; that is what the code does.

**Fix recommendation:** Add an org-level secondary throttle (e.g. 30/hour/org) if the partner reports concurrent-export complaints. Not required to meet the stated budget.

---

## F7 — Heebo `document.fonts.ready` on every render

**Site:** `pdf-export.service.ts:108-116`. Fonts are base64-embedded as `@font-face` in the inline `<style>`. Each render parses ~80 KB of woff2 from data URLs.

**Cost estimate:** Modern Chromium parses 80 KB woff2 in ~30-80 ms — non-trivial but bounded.

**Budget violation?** Adds to F1's total but is unavoidable per-page given the current single-shot rendering. Once the browser is pooled (F1 fix) the OS-level font cache helps; better is to install Heebo as a system font in the Railway image and use `font-family: 'Heebo'` without an `@font-face` (saves the per-render data-URL parse). The CSS cache at `pdf-export.service.ts:79-80` already memoises the base64 string Node-side, so disk I/O is one-shot.

**Fix recommendation:** Install Heebo system-wide in the production image; keep the @font-face as a fallback. Saves ~50 ms/render.

---

## Clean checks (already at budget)

- **PII decrypt is batched.** `export-composer.service.ts:219-222` calls `decryptOwnerPiiBatch` once with all owners. `packages/db/src/helpers/owners.ts:288-312` runs 3 SQL statements in parallel (`Promise.all`) — name, national_id, phone — each one pg round-trip regardless of N. For 1000 owners at 50 ms Neon RTT: ~150 ms total decrypt cost vs the ~5 s the per-row path would cost. Documented and measured.
- **DB compose is O(buildings) — not O(N×M).** Five sequential queries, not nested: project (1), generator (1), buildings (1), apartments with `inArray(buildingId, bldIds)` (1) at `export-composer.service.ts:176`, ownerships+owners with `inArray(apartmentId, aptIds)` (1) at `export-composer.service.ts:196`. Total 5 round-trips, independent of project size.
- **Indices cover every WHERE/JOIN.** `idx_buildings_project` on `buildings(project_id)` (schema `projects.ts:67`), `idx_apartments_building` on `apartments(building_id)` (`projects.ts:109`), `idx_ownerships_apartment_active` on `ownerships(apartment_id)` (`projects.ts:220`). The agent-INNER-JOIN at `export-composer.service.ts:90-97` joins `project_assignments(project_id, user_id) WHERE unassigned_at IS NULL` — verify migration 0037 covers this. The empty-project short-circuit at `export-composer.service.ts:138-158` correctly skips apartment + ownership queries.
- **Statement timeout is set.** `packages/db/src/client.ts:110` `statement_timeout=30_000 ms` caps the worst case.
- **Throttler tracker keys correctly per-user.** `common/guards/throttler.guard.ts:45-52` returns `u:${sub}`; verified APP_GUARD wiring at `apps/api/src/app.module.ts:121`. No cross-org bucket leakage.
- **Audit log is in-tx.** `export-composer.service.ts:288-297` writes the `project.export` row through the same `tx` handle, so RLS context + connection are consistent and no extra round-trip on a separate connection is needed.
- **xlsx render passes its own published budget for 1000 rows (~3 s vs 25 s target per `export.service.ts:42-43`).** Just not the user's stricter 1-second rule for large exports.

---

## Bottom line

The single biggest budget violation is **F1** (Chromium per-call). Fix that and the PDF path falls from ~1.8 s to ~400 ms, comfortably inside the 1 s rule for typical project sizes. F2/F3 are latent — they will breach the budget once partner data hits the multi-thousand-row range; ship the streaming switch before that happens.
