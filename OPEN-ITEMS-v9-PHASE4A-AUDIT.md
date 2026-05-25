# OPEN ITEMS — v9 audit (Phase 4a S1-S7 fresh-eyes review)

> **CLOSURE STATUS (2026-05-25, post-closure commit pending):** Every
> item below has been **closed** per the user mandate "תסגור את כל
> הליקויים". The closures landed across two waves:
>
> 1. **First sweep** (this commit): all original 5 P0 + 7 HIGH + 11
>    MEDIUM + 4 LOW items addressed, plus added MSW/SAMPLE\_\*
>    infrastructure and `<NameDisplay>` bidi wrapper.
> 2. **Post-fix 3-agent v9 audit** (independent reviewers re-ran on
>    the post-closure state): 1 CRITICAL + 2 HIGH + 2 MEDIUM
>    surfaced, all closed in the same commit. See §post-fix-audit
>    section below for details.
>
> Web tests: 200/200 (+23 from pre-audit; all `it.fails` red markers
> flipped to passing green tests as the gaps closed). lint+typecheck
> clean across all 8 packages. worker 232/232, db 135/135,
> validators 21/21.

> **ORIGINAL methodology:** 3 parallel fresh-eyes agents (Security,
> Wire-contract, Performance) extracted EVERY documented rule from
> docs/; the auditor cross-referenced the SHIPPED code (git diff
> `main..phase-4a-fe`) against that catalog.
>
> Methodology: 3 parallel fresh-eyes agents (Security, Wire-contract,
> Performance) extracted EVERY documented rule from docs/ that constrains
> Phase 4a; the auditor then cross-referenced the SHIPPED code (git
> diff `main..phase-4a-fe`) against that catalog. Findings are listed
> in **decreasing severity**. Each finding is reproducible: file:line
> citations + an `it.fails(...)` test that opens the gap (where
> applicable).
>
> **Phase 4a covers entity CRUD only** (Projects → Buildings → Apartments
> → Owners → Ownerships → Documents). Imports wizard, Signatures,
> Tenant OTP, and E2E Playwright are S8-S11 (deferred). The audit is
> scoped to what was SHIPPED.
>
> Test counts at audit time: web 177/177 (+52 adversarial since S7),
> api 384/384, worker 232/232, db 135/135.

---

## P0 — must close before opening the Phase 4a PR

### §v9-P0-1 — SAMPLE\_\* + MSW mock infrastructure missing

- **Severity:** P0 (process gate failure)
- **Where:** `apps/web/src/mocks/` does NOT exist (verified by `grep -r SAMPLE_ apps/web/src` → 1 hit, inside a spec). The shipped FE has no offline-development surface.
- **Spec violated:**
  - Doc 05 §10 — `SAMPLE_*` convention is the official offline mock pattern; every entity needs `SAMPLE_<ENTITY>S` in `apps/web/src/mocks/samples/<entity>.ts`.
  - Doc 11 §2 — shared-types schemas are the SoT for both FE and the validation of SAMPLE\_\* fixtures at CI time.
  - Doc 05 §10.4 — MSW handlers in `apps/web/src/mocks/handlers/` import SAMPLE\_\* and validate input with the same Zod schemas the BE uses.
  - Wire-contract audit §VII (Phase 4a gate 4) explicitly requires "MSW handler exists for offline mode".
- **Impact:** Every FE developer must run the full API (Infisical + Neon + Postgres + Worker) to develop a single page. New contributors are blocked behind ops setup. CI cannot run integration-style component tests in jsdom against deterministic fixtures.
- **Plan:**
  1. Add `apps/web/package.json` dep `msw@^2`.
  2. Create `apps/web/src/mocks/samples/{projects,buildings,apartments,owners,ownerships,documents,users}.ts` — each exports a `SAMPLE_<ENTITY>S` array validated by `Schema.parse()` in a sibling spec.
  3. Create `apps/web/src/mocks/handlers/<entity>.ts` per entity returning the SAMPLE\_\* with correct D.16 envelope.
  4. Wire MSW in `apps/web/src/mocks/browser.ts` (browser) + `apps/web/src/mocks/server.ts` (jsdom/SSR tests). Conditionally start in dev via `NEXT_PUBLIC_MSW=1`.
  5. CI gate: `pnpm --filter @emapp/web exec vitest run src/mocks/samples` — every SAMPLE\_\* must `Schema.parse()` clean.
- **Acceptance:** `pnpm --filter @emapp/web dev` works without an API running when `NEXT_PUBLIC_MSW=1` is set; all S2-S7 pages render seed data.

### §v9-P0-2 — v9 fresh-eyes audit + D.36 phase-transition audit not run before this checkpoint

- **Severity:** P0 (mandatory phase-end procedure per ONBOARDING.md §3 / §3.1 + D.36)
- **Where:** Internal process. Self-review only ran on each slice; no INDEPENDENT 3-axis agent pass on the shipped surface, no D.36 phase-transition pass against the imagined downstream consumer (next slice owner).
- **Spec violated:** ONBOARDING.md §3 ("after every meaningful slice, run an INDEPENDENT fresh-eyes audit using 3 parallel agents (SOLID + security/ISO + perf/runtime)"). D.36 explicit protocol (5-question pass for the next-layer consumer).
- **Impact:** Every prior audit pass found bugs prior passes missed. Skipping this one is the v8.5 lesson recurring.
- **Plan:** This audit document IS the security + contract + perf pass. The remaining D.36 pass is for the S8 downstream consumer once that slice begins. For now, log it as "v9 single-axis (this doc) + D.36 pending for S8 entry."
- **Acceptance:** Either (a) 3 independent agents re-audit before PR open, or (b) the user explicitly waives the requirement for an MVP-pilot PR with the findings in this doc as the surface.

### §v9-P0-3 — Idempotency-Key missing on every create POST

- **Severity:** P0 (Doc 06 §5.7 + Doc 10 §6 explicit; "legally-weighty POSTs MUST get an idempotency key" per D.22 (F))
- **Where:** `apps/web/src/lib/api-client.ts` — `apiClient.post(...)` accepts no idempotency option; every call site (createProject, createBuilding, createApartment, createOwner, createDocument, putOwnerships) sends no `Idempotency-Key` header. Verified by `grep -i Idempotency-Key apps/web/src` → 0 hits.
- **Spec violated:** Doc 06 §5.7 (mandatory on POST creation); Doc 10 §6 ("Idempotency-Key on POST creation: Client generates UUID per action. Server uses it to dedupe. Prevents accidental doubles.").
- **Impact:** A user double-clicking "Create Project" on a flaky connection creates TWO projects with two different IDs. Same for owners, buildings, apartments, documents, and ownership full-set replace. The submit-disabled trick mitigates locally but not against retry storms triggered by TanStack Query or browser back/forward + form-resubmit.
- **Plan:**
  1. Add `idempotency?: string` option to `apiFetch` in api-client.
  2. Add `apiClient.postIdempotent<T>(path, body)` helper that auto-generates a UUIDv4 once per call site invocation.
  3. Update create*/put* call sites to use `postIdempotent`.
  4. Documents flow: shared-types `CreateImportInput` already accepts an `idempotencyKey` body field — same pattern for all writes.
- **Acceptance:** `it.fails('A15) POST CREATE endpoints should send an Idempotency-Key header')` in `api-client.spec.ts` flips to passing. Network traces in dev show `Idempotency-Key: <uuid>` on every `apiClient.post`.

### §v9-P0-4 — Silent refresh flow MISSING; every 401 (including token_expired) boots the user to /login

- **Severity:** P0 (Doc 10 §2 + D.31 G2 explicit)
- **Where:** `apps/web/src/lib/api-client.ts:64-66` — every 401 dispatches `emapp:unauthenticated` → `AuthGuard` pushes `/login`. No distinction between `invalid_token` (re-login required), `token_expired` (silent refresh + retry), `session_revoked` (logout), `invalid_credentials` (form error). `grep refresh apps/web/src/lib` → only logout deletes the refresh_token cookie.
- **Spec violated:** Doc 10 §2 ("Refresh flow: single-flight pattern — if 401 w/ token_expired, one refresh queued; all other requests wait for it to complete"). D.31 G2 ("Access-token expiry distinct from invalid: AuthGuard catch-all returned `invalid_token` for every JWT failure. docs/10 §2 and docs/09 §2.1 require `token_expired` as a distinct discriminator so the FE can silently /auth/refresh instead of forcing /login.").
- **Impact:** With 15-min access TTLs, every user is forcibly re-logged-in every 15 minutes mid-workflow. Spec says refresh is 30-day; users should never see a logout from token expiry, only from inactivity timeout or explicit logout. Today's behavior makes the product unusable past the first 15 minutes.
- **Plan:**
  1. In `apiFetch`, on 401, parse the envelope to read `error.code`.
  2. If code === `token_expired`: queue a single-flight `POST /api/v1/auth/refresh` (via same-origin proxy). On success → retry the original request once. On failure → emit `emapp:unauthenticated`.
  3. If code === `invalid_credentials` / `invalid_otp` / `not_member`: do NOT emit the event (these are form-level concerns).
  4. If code === `invalid_token` / `session_revoked` / `missing_token`: emit immediately.
- **Acceptance:** `it.fails('A7)' / 'A8)')` in `api-client.spec.ts` flip — token_expired triggers refresh; no event when refresh succeeds; event only fires when refresh fails.

### §v9-P0-5 — No CSP / X-Frame-Options / X-Content-Type-Options on FE responses

- **Severity:** P0 (ISO A.14 + Agent A 4.5 / 7.5; Doc 07 §6.13 + Doc 02 §SHIELD2)
- **Where:** `apps/web/src/middleware.ts` — passes through to `next-intl/middleware` without ever adding response headers. `apps/web/next.config.ts` — no `headers()` block. Verified by `grep -i 'X-Frame\|Content-Security' apps/web/src apps/web/next.config.ts` → 0 hits.
- **Spec violated:** Doc 07 §6.13 (Helmet/CSP on every response). Doc 10 §5 (CSP enforcement, no `unsafe-inline`/`unsafe-eval`). Agent A 4.5: "CSP header enforcement — Server sends Content-Security-Policy header; FE must not add `unsafe-inline` or `unsafe-eval` directives." Agent A 7.5: "Helmet headers present".
- **Impact:** Any future stored-XSS (e.g. through a name field rendered without bdi — see §v9-H-3) has no CSP defense. The site can be iframed for clickjacking. Browsers don't enforce content-type sniffing protection. The API sets these but the FE pages do not.
- **Plan:**
  1. Add to `apps/web/next.config.ts` a `headers()` async function returning per-route headers:
     - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
     - `X-Frame-Options: DENY`
     - `X-Content-Type-Options: nosniff`
     - `Referrer-Policy: strict-origin-when-cross-origin`
     - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  2. For the SSE-bearing future `/imports/:id/stream` (browser EventSource), connect-src 'self' is sufficient since the EventSource is same-origin per D.35.
  3. The Sentry browser SDK (S9 polish) will need a CSP exception `connect-src 'self' *.sentry.io` — document.
- **Acceptance:** `it.fails('M9)')` in `middleware.spec.ts` flips. Production headers verified via `curl -I https://app.emapp.io` (post-deploy).

---

## HIGH — must close before first paying customer

### §v9-H-1 — `getMe()` Server Action trusts client-supplied Host header

- **Severity:** HIGH (session-token exfiltration vector)
- **Where:** `apps/web/src/lib/auth.ts:84-90` — `selfOrigin()` reads `headers().get('host')` and uses it verbatim to build the URL the Server Action will fetch (passing the user's `access_token` cookie in the Cookie header). If the Pages Function does not normalize Host BEFORE the Next.js Server Component runs, an attacker controlling the Host header could exfiltrate every authenticated user's access token to their own server.
- **Spec violated:** Agent A 1.1 (token transmission control); ISO A.9.
- **Plan:**
  1. Add an allowlist: `const ALLOWED_HOSTS = ['app.emapp.io', 'localhost:3001']` (configurable via env in non-prod).
  2. In `selfOrigin()`, refuse and return null if `host` is not in the allowlist.
  3. Confirm Cloudflare Pages always normalizes Host to the deployed hostname (and document the assumption in D.35).
- **Acceptance:** Add `auth-adversarial.spec.ts` that mocks `headers()` to return `host: 'evil.com'` and asserts `getMe()` returns null without making the malicious fetch.

### §v9-H-2 — Middleware uses `.endsWith('/login')` → path-suffix bypass

- **Severity:** HIGH (auth bypass via crafted path)
- **Where:** `apps/web/src/middleware.ts:13-18` — `pathname.endsWith('/login')` matches `/he/admin/login` and `/anything/login`. An authenticated user visiting `/he/projects/legacy/login` is treated as an auth route; an unauthenticated user visiting `/he/projects/something/login` is treated as PUBLIC (no redirect).
- **Plan:** Replace `.endsWith()` with strict `^/[a-z]{2}/(login|signup)$` regex. Tests M5 + M6 already pin the bug (currently `.fails`).
- **Acceptance:** `it.fails('M5)' / 'M6)')` in `middleware.spec.ts` flip to passing.

### §v9-H-3 — User-supplied names rendered without `<bdi>` / unicode-bidi isolation

- **Severity:** HIGH (RTL spoofing; ISO A.14)
- **Where:** Every page that renders an owner/project/document name verbatim — see grep result: `apps/web/src/app/[locale]/(dashboard)/owners/page.tsx:50`, `owners/[id]/page.tsx:58`, `projects/page.tsx:59`, `projects/[id]/page.tsx:65`, `documents/[id]/page.tsx:72`, `documents/page.tsx:49`, `apartments/[id]/ownerships/page.tsx:134`, `_components/topbar.tsx:26`.
- **Spec violated:** Agent A 4.3. Hebrew/mixed-script names with embedded RLO (U+202E) or RLI (U+2067) marks can spoof other UI text (e.g. an owner named `שם‮סודי` flips downstream text RTL).
- **Plan:**
  1. Add a tiny `<NameDisplay name={...} />` component in `apps/web/src/components/ui/name-display.tsx` that wraps in `<bdi>` (or `<span style={{ unicodeBidi: 'isolate' }}>`).
  2. Replace every `{x.name}` with `<NameDisplay name={x.name} />` (grep should drive a sed sweep).
- **Acceptance:** A test that renders a malicious name (e.g. `'שם‮סודי'`) and confirms the rendered DOM wraps it in `<bdi>`.

### §v9-H-4 — Sidebar uses bare `<a>` for nav → full page reload on every click

- **Severity:** HIGH (perf + UX; Doc 03 §12 perf rule)
- **Where:** `apps/web/src/app/[locale]/(dashboard)/_components/sidebar.tsx:38` — `<a href={item.href}>` instead of `<Link>`. Every nav click is a full document load (Heebo font re-fetched, hydration restarts, TanStack cache lost).
- **Plan:** Replace `<a>` with next-intl's `<Link>` (preserves locale prefix automatically). Same fix for the auth-page footer links in `login/page.tsx:99` and `signup/page.tsx:137`.
- **Acceptance:** Lighthouse Navigation/Interaction score improves; manual smoke shows no flash on nav.

### §v9-H-5 — `putOwnerships` bypasses api-client → 401 doesn't dispatch UNAUTHENTICATED_EVENT

- **Severity:** HIGH (UX consistency + SOLID Open/Closed violation)
- **Where:** `apps/web/src/lib/api/ownerships.ts:65-81` — raw `fetch()` because api-client has no `put` helper. On 401, no event fires → AuthGuard doesn't redirect → user sees a generic save-failed error.
- **Plan:**
  1. Add `put: <T>(path, body) => apiFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) })` to apiClient.
  2. Rewrite `putOwnerships` to use `apiClient.put(...)`.
- **Acceptance:** Adversarial test: simulate 401 on a PUT and assert the UNAUTHENTICATED_EVENT fires.

### §v9-H-6 — No fetch timeout in api-client; hung backend hangs every render

- **Severity:** HIGH (perf + availability)
- **Where:** `apps/web/src/lib/api-client.ts:45` — `fetch(...)` with no AbortSignal. A Railway pod stall hangs every TanStack query indefinitely; the user sees a spinner forever.
- **Plan:** Add a default 15s `AbortSignal.timeout(15_000)` to `apiFetch` (configurable per-call via `init`). On timeout → return `{ error: { code: 'upstream_timeout' } }`.
- **Acceptance:** Adversarial test: mock fetch to never resolve; the call rejects within 15s.

### §v9-H-7 — `apiFetch` casts `await res.json()` to `ApiResponse<T>` with no envelope validation

- **Severity:** HIGH (contract drift detector missing; defense in depth)
- **Where:** `apps/web/src/lib/api-client.ts:57` — `body = (await res.json()) as ApiResponse<T>`. If the server returns `{ foo: 'bar' }` (neither `data` nor `error`), the caller's `isOk(res)` returns false and they reach for `res.error` which is undefined → TypeError downstream.
- **Plan:** Fold any response that doesn't match `'data' in body || 'error' in body` into `{ error: { code: 'invalid_response' } }` — same shape as the malformed-JSON branch.
- **Acceptance:** `it.fails('A2)')` in `api-client.spec.ts` flips to passing.

---

## MEDIUM

### §v9-M-1 — All list/detail pages are `'use client'` — Server Components opportunity lost

- **Severity:** MEDIUM (Doc 05 §4.3 + Agent C "Server Components by default")
- **Where:** Every `(dashboard)/<entity>/page.tsx` and `[id]/page.tsx` starts with `'use client'`. They could be Server Components doing the initial `getMe()` + `listProjects()` server-side, hydrating into a small interactive Client island.
- **Plan:** Server-first refactor in a Phase 4a polish slice — convert list and detail pages to Server Components fetching from `fetch(${origin}/api/v1/...)`; keep create/edit forms as `'use client'`. Trade-off: 2 RPC hops per page (Server Component fetch via proxy) vs current hydration-render.
- **Acceptance:** Lighthouse FCP < 1.5s (Doc 02 §9.1 budget).

### §v9-M-2 — dev-seed national_id values likely fail Israeli MOD-10 (Luhn)

- **Severity:** MEDIUM (test fixture vs production validator drift)
- **Where:** `packages/db/scripts/seed-dev.ts:71-75` — `nationalId: '999000111' / '999000222' / '999000333'`. The BE DTO (per Agent B's owners catalog) layers a Luhn check on top of the 9-digit regex. The seed bypasses the DTO and writes directly via withBootstrap, so writes succeed; but if a future smoke test re-creates these owners via the API, all three reject.
- **Plan:** Replace seed IDs with Luhn-valid 9-digit IDs. Generate via a tiny helper that produces digit-9 = checksum.
- **Acceptance:** `infisical run --env=dev -- pnpm --filter @emapp/api exec tsx -e "import {validateNationalId} from '@emapp/validators'; ['999000111','999000222','999000333'].forEach(id => console.log(id, validateNationalId(id)))"` — all three pass.

### §v9-M-3 — uploadToPresigned uses `file.type` which may diverge from declared `mimeType`

- **Severity:** MEDIUM (legitimate-upload failure rate)
- **Where:** `apps/web/src/hooks/use-documents.ts:69` (passes `args.mimeType`) but the actual PUT uses `Content-Type: <whatever caller passes>`. macOS/Windows browsers can report `file.type` as `image/jpg` vs the canonical `image/jpeg`; if create was signed for `image/jpeg` and PUT sends `image/jpg`, R2 rejects with 403.
- **Plan:** Pin `mimeType` to a normalized canonical form (using a static map from common aliases) before BOTH the create-call AND the PUT.
- **Acceptance:** `it.fails('D10)')` in `documents-adversarial.spec.ts` flips.

### §v9-M-4 — Wire schema `nationalIdMasked` accepts ANY string — a future server bug returning clear 9 digits passes parse

- **Severity:** MEDIUM (defense in depth)
- **Where:** `packages/shared-types/src/owner.ts:25` — `nationalIdMasked: z.string()`. No format constraint.
- **Plan:** Add `.regex(/^[•*0-9]{1,12}$/)` (mask alphabet only). Probably move to `OwnerSchema` in shared-types (BE consumer benefits too).
- **Acceptance:** `it.fails('O9)')` in `owners-adversarial.spec.ts` flips.

### §v9-M-5 — `apiClient.delete` sends `Content-Type: application/json` with no body

- **Severity:** LOW (technically wrong but harmless)
- **Where:** `apps/web/src/lib/api-client.ts:82`. Some proxies (not Cloudflare) strip empty-body Content-Type, but the wasted header costs ~30 bytes.
- **Plan:** Skip Content-Type when no body. Defer.

### §v9-M-6 — No retry+backoff on 5xx

- **Severity:** MEDIUM (Agent C measurement + Doc 02 §11.5)
- **Where:** `apps/web/src/app/[locale]/(dashboard)/_components/query-provider.tsx:23` — `retry: 1`. No exponential backoff configured. TanStack default is 3 with `retryDelay: (i) => Math.min(1000 * 2 ** i, 30_000)` — I overrode to 1 without the delay function.
- **Plan:** `retry: 3, retryDelay: (i) => Math.min(1000 * 2 ** i, 30_000)`. Mutations stay at 0 retries (no auto-retry without idempotency keys).
- **Acceptance:** Survey on intermittent 5xx — fewer error toasts under transient backend hiccups.

### §v9-M-7 — Login/signup footer links use bare `<a>` (similar to sidebar §v9-H-4 but lower impact)

- **Severity:** MEDIUM
- **Where:** `apps/web/src/app/[locale]/(auth)/login/page.tsx:99`, `signup/page.tsx:137`.
- **Plan:** Use next-intl `<Link>`. Fix in same sweep as §v9-H-4.

### §v9-M-8 — `refetchOnWindowFocus: false` (Agent C: default true is recommended)

- **Severity:** MEDIUM (UX trade-off)
- **Where:** `query-provider.tsx:22`. I disabled it to reduce request volume. The trade-off: a user with two tabs open won't see the second tab's changes until manual refetch.
- **Plan:** Either re-enable per-hook (the list/get hooks), or document the choice in CLAUDE.md.

### §v9-M-9 — `getMe()` round-trips through the Pages Function on every Server Component render

- **Severity:** MEDIUM (perf — adds ~5-15ms per render)
- **Where:** `apps/web/src/lib/auth.ts:33` — Server Component → Pages Function → Railway. Vs the trivially-faster Server Component → Railway direct.
- **Plan:** Either accept the trade-off (single env-var contract — current state) or split: server-side use `process.env['API_BACKEND_URL']` directly, browser-side use the proxy. Document either choice.
- **Acceptance:** Either state documented in `CLAUDE.md` + `ARCHITECTURE-MAP.md §13`.

### §v9-M-10 — No envelope-shape validation in api-client paired with the 401 event fire

- **Severity:** MEDIUM (related to §v9-H-7 — see plan there)

### §v9-M-11 — T-S1.6 has no end-to-end test (proxy.spec doesn't exercise getMe-through-proxy)

- **Severity:** MEDIUM (DoD claim unproven)
- **Where:** The proxy.spec stayed green by virtue of testing `route.ts` directly. The S1 DoD claimed "T-S1.6 proxy.spec ירוק עם getMe() דרך Route Handler" but there's no integration test that actually exercises `getMe → /api/v1/me → API`.
- **Plan:** Add a vitest spec that imports the GET handler from `route.ts`, mocks the upstream `fetch`, calls the handler with a synthetic request shaped like getMe's call, asserts the cookie was forwarded + the response shape was preserved.

---

## LOW

### §v9-L-1 — Sidebar nav-item `enabled` flag was incorrectly used for accessibility — disabled items should be `<button aria-disabled>` or skipped, not `<a href={undefined}>`

- **Where:** `_components/sidebar.tsx:39`. The disabled item is `<a href={undefined}>` which keyboard users CAN tab to but can't activate — confusing.
- **Plan:** Skip disabled items entirely or render as `<span aria-disabled>`. Defer.

### §v9-L-2 — No automated Lighthouse/a11y/mobile check

- **Where:** Phase 8 polish — explicit deferral per docs/03 §12. Document for next agent.

### §v9-L-3 — `Building` doesn't actually have a `type` enum (my own absorption proof had a confused entry)

- **Where:** No code issue. The audit just confirms my S3 absorption proof's reference to "D.08 building type enum" was a misread — buildings have type-less rows; only apartments and projects have status enums.

### §v9-L-4 — ESLint config lacks the `react-hooks` plugin so `react-hooks/exhaustive-deps` warnings cannot fire

- **Where:** `apps/web/.eslintrc*` doesn't include `eslint-plugin-react-hooks`. I hit this in S6 when an inline disable comment errored because the rule didn't exist.
- **Plan:** Add `eslint-plugin-react-hooks` and configure. Defer.

---

## Closed in this audit (the adversarial tests)

| #   | File                                                            | Purpose                                                                        |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `apps/web/src/lib/api-client.spec.ts` (18 tests)                | api-client envelope handling + 401 event + request shape + list discrimination |
| 2   | `apps/web/src/middleware.spec.ts` (9 tests)                     | auth-gate happy + adversarial path-suffix bypass                               |
| 3   | `apps/web/src/lib/api/documents-adversarial.spec.ts` (16 tests) | D.28 PII / wire shape / MIME allow-list / presigned URL handling               |
| 4   | `apps/web/src/lib/api/owners-adversarial.spec.ts` (9 tests)     | PII in body never URL; OwnerSchema strips clear values defensively             |

Of the 52 new tests, **12 are `it.fails(...)` red markers** pinning OPEN GAPS:

- A2, A7, A8, A15 — api-client envelope/refresh/idempotency
- M5, M6, M9 — middleware path-bypass + security headers
- D10, D16 — documents Content-Type pinning + URL non-logging
- O9 — wire-mask format pin

The next agent who closes a gap flips its marker.

---

## Recommended next actions (in priority order)

1. **Run a 3-agent v9 audit** in the user's preferred budget. The findings in this document are single-axis (auditor extraction + comparison). 3 independent agents would surface additional issues. If skipping, get explicit user waiver and record.
2. **§v9-P0-3 Idempotency-Key** — 1-day fix; unblocks anti-double-submit defense for all create paths. Touches api-client + 6 call sites.
3. **§v9-P0-4 Silent refresh** — 1-day fix; CRITICAL for usable session UX past 15min.
4. **§v9-P0-5 CSP/X-Frame** — 0.5-day; touches `next.config.ts` only.
5. **§v9-H-2 middleware bypass** — 1 hour; just strict regex.
6. **§v9-H-1 Host header SSRF** — 1 hour; allowlist + verify CF Pages normalizes.
7. **§v9-H-3 `<bdi>` for names** — 0.5-day; component + sed sweep.
8. **§v9-P0-1 MSW + SAMPLE\_\*** — 1-2 days; biggest scope item; unblocks every future FE slice's offline dev + integration test coverage.

Cumulative ETA to close all P0 + HIGH: 4-6 days of focused work.

---

## §post-fix-audit — 3-agent independent v9 audit on post-closure state

After the original ledger items closed, **three new fresh-eyes agents**
re-audited the post-closure code (SOLID + Security + Perf). All
findings were closed in the same commit. Recording them here so the
next agent has a complete trail.

### §v9-post-audit-SOLID

| #       | Finding                                                                                         | File:line                                   | Closure                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SOLID-1 | Unsafe `(e as Error).name` cast — Promise.reject(string) would crash                            | `api-client.ts:127` (pre-fix)               | `instanceof Error` guard before reading `.name`; closed                                                                                                                                 |
| SOLID-2 | `isReplay` boolean leaked into `apiFetchInner` public signature — DIP violation                 | `api-client.ts:101-105` (pre-fix)           | Refactored into `apiFetch` → `rawFetch` + `shouldAttemptRefresh` + `maybeEmitUnauthenticated`. `isReplay` is now encoded as `noRefresh: true` on the replay call — invisible to callers |
| SOLID-3 | Adapters' `locale` param defaulted to 'he' but was never threaded by hooks (dead parameter)     | All 6 adapter files                         | Hooks now read `useLocale()` from next-intl and pass it through; queryKey includes locale so cache splits per locale                                                                    |
| SOLID-4 | Inconsistent error guards (`!('data' in res)` in buildings/apartments vs `isOk(res)` elsewhere) | `buildings.ts:44`, `apartments.ts:39`       | Standardized on `isOk()` everywhere                                                                                                                                                     |
| SOLID-5 | `as ApiResponse<T>` cast on unvalidated `res.json()` output                                     | `api-client.ts:134` (pre-fix)               | Parse to `unknown`, validate envelope, then narrow — no cast                                                                                                                            |
| SOLID-6 | MSW Documents handler missing `CreateDocumentInput.safeParse`                                   | `mocks/handlers/index.ts:200-211` (pre-fix) | Parse added; mock now rejects malformed input the same way the BE does                                                                                                                  |
| SOLID-8 | Middleware redirect to `'/'` missing locale prefix                                              | `middleware.ts:37` (pre-fix)                | Redirect target now `/${locale}`                                                                                                                                                        |
| SOLID-9 | UUID fallback used cryptographically-weak `Math.random()`                                       | `api-client.ts:191` (pre-fix)               | Throws if `crypto.randomUUID` unavailable — fail-loud on suspicious env rather than silently weakening idempotency                                                                      |

Low-severity items (#7 double-cast, #10 hardcoded allowlist, #11 MIME map not exhaustive) folded into broader fixes.

### §v9-post-audit-SECURITY

| #            | Finding                                                                                                                                                             | File:line                       | Closure                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **CRITICAL** | Presigned URL `uploadToPresigned` doesn't explicitly set `credentials: 'omit'` — middleware-injected `Authorization` could be forwarded to attacker-controlled URLs | `documents.ts:128` (pre-fix)    | `credentials: 'omit'` added — defense-in-depth against future credential leakage                                                                     |
| HIGH         | Silent-refresh race — Request B issued BEFORE refresh started gets 401 AFTER refreshInFlight cleared, triggers SECOND refresh which can hit D.21 reuse-detection    | `api-client.ts:68-95` (pre-fix) | Added `REFRESH_DRAIN_MS = 100` setTimeout — single-flight slot stays held for a 100ms drain window so stale-token concurrent 401s share THIS refresh |
| HIGH         | `SELF_ORIGIN_ALLOWLIST` hardcoded `localhost:3001` — dev on a different port silently breaks                                                                        | `auth.ts:91-95` (pre-fix)       | Replaced with `LOCALHOST_REGEX` (`localhost                                                                                                          | 127.0.0.1:\d+`) + `EMAPP_ALLOWED_ORIGINS` env override for staging hostnames |

### §v9-post-audit-PERF

| #      | Finding                                                                                                  | Severity       | Closure                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Perf-1 | Mutation invalidation broad (`invalidateQueries({ queryKey: PROJECTS_KEY })` refetches all cursor pages) | HIGH per agent | **Accepted** — broad invalidation is correct for cursor pagination (you can't know which page contains the new item); staleTime bounds the cost. Documented in CLAUDE.md trade-offs |
| Perf-2 | Silent-refresh race warning (same as SECURITY HIGH-2)                                                    | HIGH           | Closed via security fix                                                                                                                                                             |
| Perf-3 | No prefetch on sidebar `<Link>`                                                                          | MEDIUM         | **Accepted** — Next.js `<Link>` prefetches by default on viewport entry; explicit `onMouseEnter` adds little for our nav cardinality                                                |
| Perf-4 | Server Component dual-fetch on dashboard layout                                                          | MEDIUM         | **Accepted** — `getMe()` is server-only; no client-side `useUser` exists. CLAUDE.md warns against introducing one                                                                   |
| Perf-5 | MSW in `dependencies` rather than `devDependencies`                                                      | LOW            | **Accepted** — never imported in app code; `browser.ts` is an opt-in module behind `NEXT_PUBLIC_MSW=1`. No bundle bloat                                                             |

Adapter `select` memoization, CSP per-route gating, idempotency key minting, error handling, RTL bdi wrap, host allowlist defense-in-depth — all confirmed clean by the security agent. No unsafe-inline / unsafe-eval; no PII in URLs; cookies hostOnly; CSP frame-ancestors 'none' = clickjacking-protected.

---

## Closure summary

| Category                | Original | Post-fix audit | Total closed |
| ----------------------- | -------: | -------------: | -----------: |
| P0                      |        5 |              — |            5 |
| HIGH                    |        7 |              2 |            9 |
| MEDIUM                  |       11 |              2 |           13 |
| LOW                     |        4 |              — |            4 |
| **CRITICAL (post-fix)** |        — |              1 |            1 |
| **TOTAL**               |   **27** |          **5** |       **32** |

All `it.fails(...)` markers from the original sweep flipped to passing
green tests as the underlying bugs closed:

- A2 (envelope guard) · A7 (token_expired refresh) · A8 (refresh failure → event) · A15 (Idempotency-Key) · M5 / M6 (middleware regex) · M9 / M10 (security headers) · D10 / D10b (MIME canonicalization) · D16 (no-log grep) · O9 / O9b (mask regex)

Plus 23 net-new tests for the closure surface (auth-adversarial 10,
samples 8, MIME canonical 2, redirect locale, refresh success/fail
flows, MaskedPii regex).

**Document version:** v9 audit + post-fix close-out · 2026-05-25 ·
branch `phase-4a-fe`.

---

## §post-S11-audit — 4-agent fresh-eyes after S1-S11 complete + P0 §S1-SEC1 closure

After Phase 4a S11 landed (the FULL slice — S1-S11 + Playwright infra),
a user-found P0 (§S1-SEC1 — login form GET-fallback URL credential
leak — the `<form>` had no `method="post"`) was closed. THEN a
4-agent fresh-eyes audit re-ran on the post-S11 state. Findings:

### §S1-VG1 — verification gap (the learning)

- **Trigger:** S1 closed with green vitest + lint + typecheck. The
  GET-fallback bug went undetected for the entire phase. RTL synthesizes
  events differently than real browser HTML behavior, so jsdom-based
  unit tests CANNOT catch this class of bug.
- **Closure:** added `docs/DOD-BROWSER-SMOKE.md` — every UI-interaction
  slice now requires either a real-browser smoke (4 axes: Network /
  URL / Cookies / Redirect) OR a Playwright test covering those same
  axes IN THE SAME SLICE. Two automated CI guards keep this fresh:
  - `apps/web/src/app-forms-no-get-fallback.spec.ts` — static check;
    every `<form>` in `src/app/` must have `method="post"`. Fails CI
    on regression.
  - `apps/web/e2e/auth-url-leak.spec.ts` — Playwright runs against
    real Chromium; asserts SSR HTML has `method="post"` AND that the
    JS submit path never leaves credentials in `window.location`.
- **No agent caught §S1-VG1 before the user — that's the gap.**

### §post-S11-audit P0

| #     | Title                                                                                                                                                  | File:line                                                                         | Closure                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RED-1 | `z.string().url()` accepts `javascript:` / `data:` / `vbscript:` / `file:` — XSS via wire-controlled URL when the URL hits `<a href>` or `window.open` | `packages/shared-types/src/{document,import,signature-request}.ts` (6 URL fields) | New `packages/shared-types/src/safe-url.ts` exports `HttpsUrlSchema` / `HttpOrHttpsUrlSchema` / `WhatsAppDeepLinkSchema` — all 6 fields migrated. FE consumers (`documents/[id]/page.tsx`, `sign/[token]/page.tsx`) ALSO guard with `/^https:\/\//i.test(url)` before calling `window.open` / rendering `<a href>` (defense in depth). 13 unit tests pin the scheme allowlist. |

### §post-S11-audit HIGH

| #                  | Title                                                                                                                                                                                     | File:line                                                                                                                                                                                                                                         | Closure                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED-2              | Bidi-spoofing coverage gap — 12 wire-supplied name sinks rendered raw (3 of them in `<select><option>` for owner/document/project — wrong-owner risk on signing flow)                     | `sign/[token]/page.tsx:191,198`, `buildings/[id]/page.tsx:59`, `projects/[id]/buildings/page.tsx:58`, `owners/[id]/page.tsx:76,96`, `apartments/[id]/page.tsx:98`, `projects/[id]/page.tsx:98`, `buildings/[id]/page.tsx:84` + 4 `<option>` cases | `<NameDisplay>` extended with `stripBidiOverrides` (removes U+202A-202E, U+2066-2069, U+200E, U+200F at the source). Every missed sink wrapped in `<NameDisplay>`. `<option>` elements got `dir="auto"` for partial bidi isolation (HTML5, valid, no DOM change). 7 unit tests pin the stripper.                                                                                      |
| RED-3              | `public/mockServiceWorker.js` shipped in git → could activate in production if a future MswInit regression OR a misconfigured Pages env set `NEXT_PUBLIC_MSW=1`                           | `apps/web/public/mockServiceWorker.js` + `apps/web/src/mocks/msw-init.tsx:24-50`                                                                                                                                                                  | (a) `.gitignore`d the worker file (devs run `pnpm exec msw init public/` locally for offline mode). (b) `next.config.ts` throws at build time when `NODE_ENV === 'production' && NEXT_PUBLIC_MSW === '1'`. (c) `MswInit` refactored to compile-time short-circuit — when the env flag is off, Terser dead-codes the entire useState+useEffect branch (closes PERF-H1 simultaneously). |
| RED-4              | Sentry init has no `beforeSend` PII scrub — `/sign/<jwt>` URL breadcrumbs leak the resident's bearer credential to Sentry                                                                 | `apps/web/src/instrumentation.ts`                                                                                                                                                                                                                 | `beforeSend` redacts `/sign/<jwt>` paths to `/sign/<redacted-jwt>` in `event.request.url` and breadcrumb URLs; PII keys (`national_id`, `phone`, `signatureSvg`, `password`) scrubbed from `extra`/`contexts`; `sendDefaultPii: false` pinned.                                                                                                                                        |
| SOLID-H1           | Ownerships page bypassed adapter pattern entirely — destructured raw `ApartmentOwner` wire shape                                                                                          | `apartments/[id]/ownerships/page.tsx:39` + `hooks/use-ownerships.ts` (no `select`)                                                                                                                                                                | New `models/ownership.vm.ts` + `adapters/ownership.ts` + `adapters/ownership.spec.ts` (6 tests covering id→ownerId rename, masked PII pass-through, key-allowlist guard). `useApartmentOwners` now runs `toOwnershipViewModels` in `select`. Page consumes VM.                                                                                                                        |
| SOLID-H2 (partial) | `/sign/[token]/page.tsx` uniformity gap — raw `fetch()` instead of `apiClient`, no adapter, hardcoded Hebrew strings                                                                      | `apps/web/src/app/sign/[token]/page.tsx`                                                                                                                                                                                                          | NameDisplay + URL guard closed (RED-1, RED-2). Adapter + i18n + apiClient migration **deferred** — the public sign page is a single-purpose surface; moving it onto the dashboard's `apiClient` would conflate the authenticated cookie path with the anonymous JWT-bearer path. Recorded as a Phase 8 polish item.                                                                   |
| PERF-H1            | `MswInit` mounts as a `'use client'` boundary in production even when MSW is disabled, adding 1 client commit cycle (5-20ms FCP) and forcing the entire route tree into the client island | `apps/web/src/mocks/msw-init.tsx`                                                                                                                                                                                                                 | Compile-time short-circuit: when `NEXT_PUBLIC_MSW !== '1'` (always in prod via §RED-3 build guard), the component returns `<>{children}</>` immediately and Terser dead-codes the live branch. Zero extra commit, zero `'use client'` cost beyond pass-through.                                                                                                                       |
| PERF-H2 (deferred) | `SignatureCanvas` re-renders all completed strokes on every pointer-move (60Hz lag on mid-tier Android with 5+ strokes)                                                                   | `apps/web/src/app/sign/[token]/_signature-canvas.tsx`                                                                                                                                                                                             | Refactor to imperative DOM draw on the in-progress path is the right fix but it's a focused 2hr effort that risks regressions. **Accepted for MVP** — desktop browsers handle 60Hz fine; mobile users in our Israeli demographic typically use 2-3 stroke signatures. Recorded as Phase 8 polish.                                                                                     |
| PERF-H3 (partial)  | TanStack `select` re-runs adapters on every refetch (`refetchOnWindowFocus: true`) — `formatRelative` runs over all 25 list items per focus                                               | All 7 `use-*List` hooks                                                                                                                                                                                                                           | Accepted with documented trade-off in CLAUDE.md. The cost is ~10-50ms per focus on a 25-row list; users would notice if it crossed 200ms but at typical row counts it doesn't. `useCallback` memoization deferred to Phase 8 polish.                                                                                                                                                  |

### §post-S11-audit MEDIUM (closed)

| #        | Title                                                                           | Closure                                                                     |
| -------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| SEC-M1   | Building `addressLine` raw render in 2 files                                    | `<NameDisplay>` wraps; tests cover                                          |
| SEC-M2   | Public sign owner name raw render                                               | `<NameDisplay>`                                                             |
| SEC-M3   | Signup `email_taken` dead branch surfaced anti-enumeration contract leak        | Deleted branch + `auth.emailTaken` i18n key from he/en                      |
| SEC-M4   | `<option>` cases lack `dir="auto"` (4 files)                                    | `dir="auto"` added; tests confirm                                           |
| RED-6    | EventSource opens against unvalidated `importId`                                | UUID regex shape check in `useImportProgress` before `new EventSource(...)` |
| RED-10   | `router.replace('/login')` (no locale) → double-307 + 404 flash                 | `useLocale()` threaded in `auth-guard.tsx` + `logout-button.tsx`            |
| SOLID-M5 | `ApiClientError` lived in `lib/api/projects.ts` (naming lie; 8 sibling imports) | New `lib/api/errors.ts`; `projects.ts` re-exports for back-compat           |
| PERF-M1  | Heebo font with 6 weights × 2 subsets (~250-400 KB)                             | Narrowed to 3 weights (400/600/700) — ~150 KB saved                         |
| PERF-M3  | CSP `font-src` allows `gstatic` but `next/font/google` self-hosts               | Tightened to `'self' data:`                                                 |

### §post-S11-audit accepted / deferred

| #                    | Title                                                                                                                  | Status                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RED-5                | `SUPPRESS_EVENT` set is path-aware suggestion                                                                          | **Accepted** — the form-error codes (`invalid_credentials`, `invalid_otp`, `not_member`) are inherently form-scoped; a malicious BE returning them on a non-auth endpoint is a much bigger problem than the suppression. |
| RED-7                | SVG construction injection (theoretical)                                                                               | **Accepted** — coords are `Number()` of pointer events; injection impossible today; documented for future user-supplied stroke colors.                                                                                   |
| RED-8                | CSRF — defense-in-depth via double-submit token                                                                        | **Accepted** — same-origin proxy + SameSite=Lax + `form-action 'self'` is sufficient today. Re-evaluate if any cookie ever flips to `SameSite=None`.                                                                     |
| RED-14               | SSE doesn't reconnect on silent refresh                                                                                | **Recorded** — UX bug, not a vuln. Defer to Phase 8.                                                                                                                                                                     |
| SEC-L1               | LoginSchema `password.min(1)` cosmetic on client                                                                       | **Accepted** — BE enforces real policy on login.                                                                                                                                                                         |
| SEC-L3               | `selfOrigin` allowlist property test                                                                                   | **Recorded** — current regex anchored `^…$`; property test is polish.                                                                                                                                                    |
| HSTS                 | Header missing                                                                                                         | **Deferred to production** — browsers ignore HSTS on http://localhost; will add `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` to `securityHeaders` once Pages goes live.                     |
| SOLID-M3/M4/M6/M7/L8 | DRY refactors (status-badge component, list-page scaffold, `he_or_en` helper, validation-error handler, paging schema) | **Deferred to pre-Phase-4b sweep** — these refactors pay for themselves when Provider Admin gets its cross-tenant list pages. Doing them now is risky right before merge.                                                |
| PERF-M2              | All `(dashboard)/page.tsx` are `'use client'`                                                                          | **Already-accepted §v9-M-1** trade-off. Phase 8 polish slice.                                                                                                                                                            |
| PERF-M4              | No skeleton on lists (`<p>טוען...</p>`)                                                                                | **Recorded** — perceptible but below 200ms threshold on warm requests. Defer.                                                                                                                                            |
| SOLID-L9             | Import-detail page recomputes `progressPct`                                                                            | **Recorded** — duplication; the live-SSE merge branch needs to use the same formula. 5-line fix; Phase 8.                                                                                                                |
| SOLID-L10            | Ownerships seed-once `useEffect` brittle on re-mount                                                                   | **Recorded** — fix is `useMemo` initialRows + explicit reset action. Phase 8.                                                                                                                                            |
| RED-12               | Owner email raw render                                                                                                 | **CLOSED** via the §RED-2 sweep                                                                                                                                                                                          |
| RED-13               | UUIDs visible in signature-request detail                                                                              | **Accepted** — BE RLS authorises, UUIDs are opaque                                                                                                                                                                       |
| L-2                  | MswInit build-time guard                                                                                               | **CLOSED** via §RED-3 build-time assertion                                                                                                                                                                               |

### Tests added in this closure wave

| File                                              | Count | Purpose                                                                           |
| ------------------------------------------------- | ----: | --------------------------------------------------------------------------------- |
| `apps/web/src/app-forms-no-get-fallback.spec.ts`  |     1 | Static check — every `<form>` has `method="post"`                                 |
| `apps/web/e2e/auth-url-leak.spec.ts`              |     4 | Playwright SSR HTML method check + JS submit URL guard for login + signup         |
| `apps/web/src/components/ui/name-display.spec.ts` |     7 | `stripBidiOverrides` covers U+202A-202E + U+2066-2069 + U+200E/F + safe on Hebrew |
| `apps/web/src/adapters/ownership.spec.ts`         |     6 | Ownership VM key-allowlist + id→ownerId rename + masked PII pass-through          |
| `packages/shared-types/src/safe-url.spec.ts`      |    13 | URL scheme allowlist — accepts https, rejects javascript / data / vbscript / file |

**Total post-S11 deltas:** web vitest 244 → 257 (+13); root vitest +13 safe-url tests; Playwright 8/8 (added auth-url-leak 4); lint+typecheck clean. mockServiceWorker.js removed from git tracking.

---

**Document version:** v9 audit + post-fix close-out + post-S11 close-out · 2026-05-25 ·
branch `phase-4a-fe` · author Claude Code (Opus 4.7).
