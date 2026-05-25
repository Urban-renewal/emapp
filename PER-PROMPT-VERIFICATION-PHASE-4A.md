# Per-Prompt Verification — Phase 4a (S1-S11)

**Date:** 2026-05-25
**Branch:** `phase-4a-fe`
**Method:** Walk through each S as a separate prompt; verify against the user's brief from the original GO message; cite files; flag deltas.

## Legend

- ✅ Delivered as specified
- ⚠️ Delivered with documented trade-off / partial
- ❌ Missed / regressed
- 🐛 Bug shipped (verification gap)

---

## S1 — Manager shell + auth UX

| Sub-task                                      | Status              | Evidence                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-S1.1 Logout (Server Action + cookie delete) | ✅                  | [auth.ts](apps/web/src/lib/auth.ts) `logout()` + [logout-button.tsx](<apps/web/src/app/[locale]/(dashboard)/_components/logout-button.tsx>)                                                                                                                                                                                                                                         |
| T-S1.2 Dashboard shell (sidebar + topbar)     | ✅                  | [(dashboard)/layout.tsx](<apps/web/src/app/[locale]/(dashboard)/layout.tsx>) + [\_components/sidebar.tsx](<apps/web/src/app/[locale]/(dashboard)/_components/sidebar.tsx>), [\_components/topbar.tsx](<apps/web/src/app/[locale]/(dashboard)/_components/topbar.tsx>)                                                                                                               |
| T-S1.3 Mid-session 401 → /login               | ✅                  | [api-client.ts](apps/web/src/lib/api-client.ts) `UNAUTHENTICATED_EVENT` + [auth-guard.tsx](<apps/web/src/app/[locale]/(dashboard)/_components/auth-guard.tsx>)                                                                                                                                                                                                                      |
| T-S1.4 validation_error → field-level         | ✅                  | [errors.ts](apps/web/src/lib/errors.ts) `applyValidationErrors` + [errors.spec.ts](apps/web/src/lib/errors.spec.ts) 8 tests                                                                                                                                                                                                                                                         |
| T-S1.5 API_URL → API_BACKEND_URL (D.35)       | ✅                  | [auth.ts](apps/web/src/lib/auth.ts) reads only API_BACKEND_URL + [auth.spec.ts](apps/web/src/lib/auth.spec.ts) static-grep guard                                                                                                                                                                                                                                                    |
| T-S1.6 getMe through proxy                    | ✅                  | [auth.ts](apps/web/src/lib/auth.ts) uses `selfOrigin()` from `headers()`                                                                                                                                                                                                                                                                                                            |
| T-S1.7 seed-dev script                        | ✅                  | [seed-dev.ts](packages/db/scripts/seed-dev.ts) idempotent withBootstrap; Israeli Luhn IDs                                                                                                                                                                                                                                                                                           |
| **🐛 §S1-VG1 — GET-fallback URL leak**        | **CLOSED post-S11** | Login form lacked `method="post"`. Fixed in [commit 1455d27](https://github.com/Urban-renewal/emapp/commit/1455d27); pinned by [app-forms-no-get-fallback.spec.ts](apps/web/src/app-forms-no-get-fallback.spec.ts) + [e2e/auth-url-leak.spec.ts](apps/web/e2e/auth-url-leak.spec.ts). Verification-gap learning recorded in [docs/DOD-BROWSER-SMOKE.md](docs/DOD-BROWSER-SMOKE.md). |

**Verdict:** S1 ✅ + 🐛→CLOSED. Major learning: jsdom RTL cannot catch SSR HTML attribute bugs; real-browser smoke is non-negotiable for interactive UI.

---

## S2 — Projects CRUD (D.18 status LAW, adapter pattern)

| Sub-task                             | Status | Evidence                                                                                                                                          |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter pattern (Wire→VM)            | ✅     | [adapters/project.ts](apps/web/src/adapters/project.ts) + [models/project.vm.ts](apps/web/src/models/project.vm.ts)                               |
| D.18 status enum HE/EN labels        | ✅     | Adapter has STATUS_LABELS + adapter spec asserts `Object.keys(STATUS_LABELS) === Object.keys(ProjectStatusEnum)` so future enum additions fail CI |
| TanStack Query at dashboard          | ✅     | [QueryProvider](<apps/web/src/app/[locale]/(dashboard)/_components/query-provider.tsx>)                                                           |
| List + view + create + archive       | ✅     | `/projects`, `/projects/[id]`, `/projects/new`; archive via `window.confirm`                                                                      |
| Cursor pagination (D.24 — no offset) | ✅     | API client `getList` returns `{ items, page: { limit, cursor, has_more } }`                                                                       |
| Sidebar projects link enabled        | ✅     | sidebar.tsx `enabled: true`                                                                                                                       |

**Verdict:** S2 ✅ clean.

---

## S3 — Buildings CRUD nested under projects

| Sub-task                                               | Status | Evidence                                                            |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------- |
| List + create at /projects/[id]/buildings              | ✅     | Matches BE controller URL plan                                      |
| View + archive at /buildings/[id]                      | ✅     | Mirrors BE                                                          |
| BuildingViewModel: addressLine + parcelSummary (HE/EN) | ✅     | [adapters/building.ts](apps/web/src/adapters/building.ts) + 8 tests |
| Project detail links to buildings                      | ✅     | "ניהול הבניינים" card                                               |

**Verdict:** S3 ✅ clean.

---

## S4 — Apartments CRUD nested under buildings

| Sub-task                                             | Status | Evidence                                                                       |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| Nested URL: /buildings/[id]/apartments               | ✅     | Matches BE                                                                     |
| ApartmentViewModel + 4-color status palette          | ✅     | signed=emerald, refused/unreachable=red, contacted/meeting=amber, pending=gray |
| factsLine omits null fields                          | ✅     | Adapter spec covers null cases × HE/EN                                         |
| Entity == "apartment" verbatim (CLAUDE.md hard rule) | ✅     | grep confirms no "unit" usage                                                  |
| UI label "דירה" everywhere                           | ✅     | i18n he.json                                                                   |

**Verdict:** S4 ✅ clean.

---

## S5 — Owners CRUD with PII discipline (D.19)

| Sub-task                                                     | Status | Evidence                                                                           |
| ------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------- |
| Wire carries nationalIdMasked + phoneMasked only             | ✅     | Owner schema in shared-types; MaskedPii regex enforces bullet/asterisk presence    |
| ViewModel has NO `nationalId`/`phone`/`national_id` keys     | ✅     | [owner.spec.ts](apps/web/src/adapters/owner.spec.ts) #4 pins the key-allowlist     |
| POST /owners/search with body (PII not in URL/query)         | ✅     | [lib/api/owners.ts](apps/web/src/lib/api/owners.ts) `searchOwner`                  |
| inputMode="numeric" + maxLength=9 + dir="ltr" on national_id | ✅     | [owners/new/page.tsx](<apps/web/src/app/[locale]/(dashboard)/owners/new/page.tsx>) |
| owner_exists → field-level error on national_id              | ✅     | onSubmit catch handler                                                             |
| Sidebar owners link enabled                                  | ✅     | sidebar.tsx                                                                        |

**Verdict:** S5 ✅ clean (P0 form fix retroactively applies here too — national_id now safe even on GET-fallback).

---

## S6 — Ownerships atomic set-replace (D.25)

| Sub-task                                    | Status | Evidence                                                           |
| ------------------------------------------- | ------ | ------------------------------------------------------------------ |
| /apartments/[id]/ownerships page            | ✅     | Set-replace UI                                                     |
| PUT /apartments/:apartmentId/ownerships     | ✅     | `putOwnerships` (api-client got `put` method in v9 audit closures) |
| Sum-100 triple validation                   | ✅     | FE counter + Zod safeParse + BE deferred trigger                   |
| 50-row cap                                  | ✅     | Tested in ownerships.spec.ts                                       |
| Seed-once useEffect populates existing rows | ✅     | Standard pattern                                                   |

**Verdict:** S6 ✅ clean.

---

## S7 — Documents (D.28) 3-phase upload

| Sub-task                                            | Status | Evidence                                                                                 |
| --------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| POST /documents → presigned URL                     | ✅     | `createDocument` returns `{ document, uploadUrl, uploadExpiresInSeconds }`               |
| XHR PUT direct to R2 with bound MIME                | ✅     | `uploadToPresigned` uses XHR; `credentials: 'omit'` on PUT (CRITICAL §v9-post-audit fix) |
| POST /documents/:id/finalize (size + sha256 verify) | ✅     | `finalizeDocument`                                                                       |
| Storage key NEVER on wire                           | ✅     | Schema in shared-types excludes file_r2_key                                              |
| GET /documents/:id/download → 2-min presigned GET   | ✅     | `getDownloadUrl`                                                                         |
| FE MIME allow-list + 50MB cap before API call       | ✅     | `canonicalMime` + size check in `useUploadDocument`                                      |
| Sidebar documents link enabled                      | ✅     | sidebar.tsx                                                                              |

**Verdict:** S7 ✅ clean (including the §v9-post-audit CRITICAL closure for presigned URL credentials).

---

## S8 — Imports Wizard (D.34)

| Sub-task                                                                      | Status | Evidence                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| sha256 client-side → POST /imports (presigned PUT)                            | ✅     | `sha256OfBlob` produces bare hex (v8 SOLID-2 contract); `CreateImportInput.parse(body)` defensive                                         |
| XHR upload to R2 with progress events                                         | ✅     | `uploadToPresignedXhr` uses XHR.upload.onprogress                                                                                         |
| POST /imports/:id/start enqueues worker                                       | ✅     | `startImport` with empty body                                                                                                             |
| Native EventSource on /imports/:id/stream                                     | ✅     | [use-import-progress.ts](apps/web/src/hooks/use-import-progress.ts) parses every frame via `ImportSseEventSchema.parse(JSON.parse(line))` |
| 8-state machine adapter (HE/EN, isTerminal, isCancellable, isAwaitingMapping) | ✅     | [adapters/import.ts](apps/web/src/adapters/import.ts) + 16 tests covering exhaustive enum                                                 |
| awaiting_mapping → /imports/[id]/mapping wizard                               | ✅     | 6 canonical fields, duplicate detection, optional template name, defensive safeParse                                                      |
| 6 error codes mapped to localized UX                                          | ✅     | upload_failed/import_conflict/upload_size_mismatch/storage_unavailable/validation_error/wrong_file_type                                   |
| Sidebar imports enabled                                                       | ✅     | sidebar.tsx                                                                                                                               |
| MSW handlers + SAMPLE_IMPORTS                                                 | ✅     | All 8 endpoints stubbed; SAMPLE covers parsing/done/awaiting_mapping                                                                      |
| samples.spec drift gate                                                       | ✅     | ImportJobSchema + ImportErrorSchema parse tests                                                                                           |

**Verdict:** S8 ✅ clean.

---

## S9 — Signature Requests (D.12 manager side)

| Sub-task                                           | Status | Evidence                                                                                                                                                                         |
| -------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /signature-requests → one-shot signUrl reveal | ✅     | Copy-to-clipboard + warning; never persisted in TanStack cache                                                                                                                   |
| List with status filter + keyset cursor            | ✅     | `useSignatureRequestList({ status, cursor })`                                                                                                                                    |
| Detail page with delivery report                   | ⚠️     | Detail renders status/IDs/timestamps but does NOT show delivery report (BE returns it only on create response, not on detail GET). User wanted "delivery report card" — partial. |
| Cancel: idempotent on cancelled, 409 on signed     | ✅     | UX message wired                                                                                                                                                                 |
| 3-state adapter (pending/signed/cancelled) HE/EN   | ✅     | [adapters/signature-request.ts](apps/web/src/adapters/signature-request.ts) + 15 adversarial tests                                                                               |
| isCancellable = pending AND !expired               | ✅     | Tested                                                                                                                                                                           |
| Sidebar signature-requests enabled                 | ✅     | sidebar.tsx                                                                                                                                                                      |
| MSW handlers + SAMPLE_SIGNATURE_REQUESTS           | ✅     | All 4 manager endpoints stubbed; all 3 statuses in fixture                                                                                                                       |
| no-jti / no-token wire invariant test              | ✅     | samples.spec.ts #12                                                                                                                                                              |

**Verdict:** S9 ✅ (one ⚠️: delivery report only shown on create, not detail — fixable later or accept as MVP scope).

---

## S10 — Public /sign/[token] (D.12 atomic single-use)

| Sub-task                                              | Status | Evidence                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /sign/<jwt> outside [locale]                          | ✅     | `apps/web/src/app/sign/` (own minimal Hebrew-RTL layout)                                                                                                                                                                                                               |
| Middleware JWT-shape regex bypass                     | ✅     | `PUBLIC_LOCALE_AGNOSTIC_REGEX`                                                                                                                                                                                                                                         |
| Anti-enumeration UX (every error → "הקישור אינו תקף") | ✅     | Stage='invalid' for any 401/403/500                                                                                                                                                                                                                                    |
| Atomic single-use authoritative on BE                 | ✅     | FE just renders signedAt on success                                                                                                                                                                                                                                    |
| SVG canvas with touch-action:none                     | ✅     | [\_signature-canvas.tsx](apps/web/src/app/sign/[token]/_signature-canvas.tsx)                                                                                                                                                                                          |
| Self-contained `<svg xmlns viewBox>` output           | ✅     | Matches PublicSignSubmitInput schema                                                                                                                                                                                                                                   |
| 50-262144 byte cap, regex-validated                   | ✅     | Defensive safeParse before POST                                                                                                                                                                                                                                        |
| `credentials: 'omit'` on GET + POST                   | ✅     | No manager cookies sent on public wire                                                                                                                                                                                                                                 |
| robots: noindex/nofollow/nocache/noimageindex         | ✅     | sign/layout.tsx metadata                                                                                                                                                                                                                                               |
| OTP flow                                              | ❌     | **NOT implemented.** User S10 brief said "Public /sign/[token] page + OTP flow" but the BE doesn't have a tenant OTP endpoint (it's D.20 deferred). The signing token IS the credential; OTP would gate general Tenant access (different flow). Recorded as scope-cut. |

**Verdict:** S10 ✅ ❌. OTP scope explicitly out per D.20 deferral; sign flow itself is clean.

---

## S11 — Playwright E2E happy path + CI

| Sub-task                            | Status | Evidence                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @playwright/test installed + config | ✅     | playwright.config.ts                                                                                                                                                                                                                                              |
| CI job (install chromium + run)     | ✅     | .github/workflows/ci.yml `e2e` job                                                                                                                                                                                                                                |
| 5 critical UI flows                 | ❌     | **Only 4 middleware tests landed** (malformed token redirect, fake JWT redirect, valid JWT no redirect, /he/login renders). Full UI flow (canvas draw → submit → success) deferred due to dev-mode SSR hydration race that needs `next start` mode or BE fixture. |
| MSW init provider wired             | ✅     | `msw-init.tsx` for offline dev                                                                                                                                                                                                                                    |
| **CRITICAL middleware matcher fix** | ✅     | Default matcher excluded dot-containing paths → bypassed /sign/<jwt> entirely. Added explicit /sign/:path\* matcher entry. Without Playwright we wouldn't have caught it.                                                                                         |

**Post-S11 additions (P0 §S1-SEC1 closure):**

- 4 auth URL-leak Playwright tests (SSR HTML method="post" + JS-path window.location absence of credentials)
- Static check for every form having method="post"

**Verdict:** S11 ⚠️. 4 E2E tests + 4 auth URL-leak tests = 8 working tests, but the user's brief was 5 UI-flow happy paths. The middleware tests are arguably more valuable (they uncovered a real auth-gate bypass bug), but the UI-flow coverage is a TODO.

---

## Summary

- **S1-S9, S10-sign, S11-infra: delivered.**
- **🐛 §S1-VG1 (GET-fallback URL credential leak) — shipped silently in S1, caught by user, CLOSED post-S11.** Process learning: jsdom RTL cannot catch SSR HTML attribute bugs; mandatory browser smoke DoD added (docs/DOD-BROWSER-SMOKE.md).
- **⚠️ S9 delivery report partial** — only shown on create response, not detail page (BE shape limitation).
- **❌ S10 OTP** — out of scope per D.20 deferral. Signing flow itself is clean.
- **⚠️ S11 UI-flow happy paths** — 4 middleware tests landed instead of 5 UI flows. Caught a critical matcher bug. UI flow E2E deferred.

**No regressions in BE contract** (the `OPEN-ITEMS-v9-PHASE4A-AUDIT.md` ledger pins every closure with file:line).
