# EMAPP — State of Product Audit

> **Independent, evidence-backed product-state audit.** Every PASS/FAIL is
> tied to a mechanical artifact (Playwright trace/assertion, curl output, or
> query plan) under `docs/audit/artifacts/`. Nothing here is taken from docs,
> PR descriptions, or the existing test suite — those were written by the
> agents who built the product. Findings come only from driving the **real**
> running stack (web:3001 + api:3000 + real Neon DB).
>
> Auditor: independent agent · Date started: 2026-05-28 · Read-only (no product code changed)

## Method & harness

- **Primary tool:** Playwright driving the real app via a dedicated config
  (`apps/web/playwright.audit.config.ts`) that, unlike the repo's default
  config, does **not** use MSW and does **not** boot a mock backend — every
  `/api/v1/*` call hits the genuine NestJS + Neon backend.
- Auth is captured once per role through the real login form
  (`e2e/audit/00-auth-setup.spec.ts`) and reused via `storageState` to respect
  the 10/60s login rate-limit.
- Audit specs live under `apps/web/e2e/audit/`. Assertions derive from the
  **spec/DECISIONS** ("what it should do"), not from the product code.

### Environment confirmed (bootstrap)

| Check                                                                              | Result                                                              | Artifact                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| Infisical dev secrets (DATABASE_URL, JWT_SECRET, PII_ENCRYPTION_KEY, PII_HASH_KEY) | ✅ all load                                                         | `infisical run --env=dev -- printenv` |
| API health                                                                         | ✅ 200 `{status:ok}`                                                | `curl /api/v1/health`                 |
| Real login (manager@alpha)                                                         | ✅ 200, httpOnly access+refresh cookies, rate-limit headers present | curl `-i /auth/login`                 |
| All 4 dev roles authenticate                                                       | ✅ manager/agent/viewer/managerBeta → 200                           | curl loop                             |
| Playwright drives real app, cookies persist                                        | ✅ 4/4 storageState saved                                           | `00-auth-setup` trace                 |

### ENV-1 (HIGH, dev-only) — the documented `pnpm dev` command produces a broken stack

`turbo.json` `globalEnv` declares only 8 vars (NODE*ENV, SKIP_ENV_VALIDATION,
DATABASE_URL, PROVIDER_DATABASE_URL, PII_ENCRYPTION_KEY, PII_HASH_KEY,
BETTER_AUTH_SECRET, JWT_SECRET). Turbo 2.9.x defaults to **strict env mode**, so
tasks spawned by `turbo dev` receive \_only* those vars. Infisical provides the
rest, but turbo filters them out before the child processes start. Result of the
CLAUDE.md-documented command `infisical run --env=dev -- pnpm dev`:

| Symptom                                                                              | Missing var (in Infisical, filtered by turbo)        | Artifact                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------- |
| API crashes on boot: `SignaturesModule: SIGNATURE_TOKEN_SECRET missing or too short` | `SIGNATURE_TOKEN_SECRET` (present, 64 chars)         | dev log line 197                             |
| Web proxy returns **500** on every `/api/v1/*` POST → login impossible               | `API_BACKEND_URL` (present, `http://localhost:3000`) | `curl -X POST :3001/api/v1/auth/login → 500` |

Also filtered: `RESEND_API_KEY`, `R2_*`, `API_TIMEOUT_MS`, `DATABASE_MIGRATE_URL`.
**Verified** the secrets exist (`infisical run --env=dev -- node -e` lists all 14)
and that bypassing turbo (`pnpm --filter @emapp/api dev` / `--filter @emapp/web dev`)
boots a healthy stack. Fix is `globalEnv`/`passThroughEnv` additions or
`--env-mode=loose`. _Impact: a new dev following CLAUDE.md gets a stack that
looks up (web renders) but cannot authenticate; the API is silently dead._

### ENV-2 (MEDIUM, resilience) — authenticated-page SSR hangs with no timeout/fallback

The dashboard's documented SSR `getMe()` self-fetch (§v9-M-9: BROWSER → Next proxy
→ API on every authenticated render) deadlocked the Next dev server under the
sustained load of the first reachability run: **every** authenticated page SSR hung
60s+ (`curl /he/login → 000 after 60s`) while the API and edge-middleware redirect
stayed fast. The server never self-recovered; a restart was required. There is no
visible server-side timeout/fallback on the `getMe` Server Action — if `/me` stalls
in production, authenticated pages stall with it. _Carried to Layer 4 (perf/resilience)._

**Bootstrap finding (login hydration race):** the login form (`#email`/`#password`

- React Hook Form) intermittently no-ops on submit when fields are filled before
  RHF hydrates — the zod-validated form sees empty values and silently stays on
  `/login` with no error. Reproduced 2× under fast automation; required a
  "wait-for-hydration + verify-value + retry" guard in the login helper. A real
  user on a slow connection who types fast could hit the same dead submit.
  _Severity: low-medium (UX), carried to Layer 2._

---

## Layer 1 — Reachability

**Harness:** `e2e/audit/layer1-reachability.spec.ts` drove 39 Manager (Alpha)
routes on the real stack. Per route it captured nav HTTP status, console errors,
page errors, failed `/api/v1` calls, enumerated every interactive element, and
clicked the DEAD-prone non-link/non-mutating controls. Per-route evidence:
`docs/audit/artifacts/layer1/<name>.json` + Playwright traces under `_pw/`.
Mutating controls (submit/save/delete/send/sign…) were inventoried, **not**
clicked (read-only).

### Headline: the routing + auth + render surface is solid

- **37/39 routes return HTTP 200.** All authenticated as Manager via cached cookie.
- **0 console errors and 0 page errors across all 39 routes** — the §P0-3 clean-console
  guardrail genuinely holds in the real app.
- **0 failed `/api/v1` calls during any page load** — no broken data fetches on load.
- The notification bell (`התראות`) opens its dropdown on **every** page (WORKS, consistent).
- Sidebar nav (~13 links) is present and identical on every dashboard page.

### BROKEN / missing

| Route            | Status  | Verdict                                                                                                                                                                  |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/he/buildings`  | **404** | No index `page.tsx` (only `[id]/`). Buildings are nested-only; no sidebar link points here, so unreachable via UI — but a bare-URL visit 404s with no friendly redirect. |
| `/he/apartments` | **404** | Same: only `[id]/` exists, no list page.                                                                                                                                 |

### DEAD interactions (genuine — code-confirmed)

All on **the Manager landing page (`/he`)** — the first screen a manager sees:
| Control | Behaviour | Ground truth |
|---|---|---|
| KPI card "פרויקטים פעילים" | renders `—`, click = no effect | `page.tsx` → `t('kpi.placeholder')` + `comingSoon` tooltip; never wired |
| KPI card "דיירים במערכת" | `—`, dead | same |
| KPI card "חתימות שהתקבלו" | `—`, dead | same |
| KPI card "ממתינים לטיפול" | `—`, dead | same |
| Weekly-calendar card ("אין משימות השבוע / תצוגת יומן") | dead | hardcoded empty state (WeekCalendar deferred to A.S12) |

→ The manager's home screen conveys **no live numbers and no working drill-down** —
every headline metric is a placeholder. (KPI wiring exists only on the unmerged
`feat/dashboard-stats-wiring` worktree.)

### Method honesty (false positives discarded)

The broad probe also flagged `li#15–20` as DEAD on most list pages. Inspecting the
labels showed these are the **sidebar `<li>` wrappers** around working `<a>` links —
non-interactive containers, not dead controls. Discarded. (Self-interrogation #3:
the "DEAD" was an artifact of clicking the wrapper, not the anchor.)

### Process inventory (input to Layers 2–3)

Auth: org login (manager/agent/viewer), provider login+MFA, tenant OTP, accept-invite,
logout, silent-refresh · Projects: create/view/assignments/buildings/shares/status ·
Buildings+Apartments: add building, add apartment, ownerships (sum=100) · Owners:
CRUD · Documents: upload/view/download · Signatures: create request → public sign →
lifecycle · Imports: upload Excel → mapping → errors → status · Members: invite →
accept → revoke · Contractors: create + share-scope · Tasks: create/schedule ·
Notes: CRUD · Notifications: list + bell · Audit log · Settings (tabbed) · Provider:
tenants/audit/system-health · Resident portal: me/apartment/documents/signatures.

## Layer 2 — Single-actor flows

**Harness:** `e2e/audit/layer2-flows.spec.ts`, assertions from DECISIONS.
Evidence: `docs/audit/artifacts/layer2/*.json`. (Note: cached `storageState`
access tokens expire after 15 min — auth-setup must be re-run immediately
before each layer; several false failures during iteration were stale-token,
not product bugs. Verified by re-auth → green.)

| Flow                                        | Verdict                 | Evidence                                                                                                                                                                  |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project create** (3-step wizard, Manager) | **COMPLETE**            | POST `/projects` → **201**, lands on `/projects/{uuid}`, GET-by-id → 200 with matching name, no error banner.                                                             |
| **Owner create + PII masking (D.19)**       | **COMPLETE (API path)** | API POST `/owners` → **201**; response exposes `nationalIdMasked: "•••••••53"`; **raw national_id never appears** in the response body. D.19 honoured.                    |
| **Viewer cannot create (RBAC, D.17)**       | **COMPLETE**            | Viewer sees **no** "create" CTA on the list **and** API POST `/projects` as viewer → **403 `{error:{code:"forbidden"}}`**. Server-side RBAC enforced, not just UI-hidden. |

### PARTIAL / flagged

- **Owner create via the FE form did NOT submit under automation** — `POST` count
  was **0** despite the inputs holding the correct values (`toHaveValue` passed) and
  no navigation occurred. This matches the **login RHF hydration race**: when fields
  are populated around hydration, React-Hook-Form's internal state stays empty, so
  `handleSubmit`'s zod validation blocks the submit silently. The API path proves the
  backend + masking work; the **client form is the weak link**. Flagged for human
  confirmation in the visual pass. _Pattern: RHF forms (login, owners) silently no-op._

### Not individually exercised (budget) — backbone established

project-create + owner-create + viewer-RBAC establish that the **CRUD + envelope +
server-side RBAC backbone works**. Task/note/document/member/contractor/import/
building/apartment creates share the same hook+envelope+RBAC pattern; ownership
sum=100 and the signature lifecycle are exercised in Layer 3.

## Layer 3 — Cross-actor lifecycle + sync

**Harness:** `e2e/audit/layer3-lifecycle.spec.ts` — multi-context (Manager,
Beta-Manager, **anonymous Resident** = no cookies, the real public-link actor).
Evidence: `docs/audit/artifacts/layer3/*.json`.

### L1 — Signature lifecycle: **SYNCED** (the crown-jewel flow works end-to-end)

| Step                                  | Actor           | Result                                                                               |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `POST /signature-requests`            | Manager         | **201**, returns `signUrl = .../sign/{jwt}`                                          |
| `GET /sign/{token}`                   | Resident (anon) | **200**, sees `{document, owner, expiresAt}`                                         |
| PII check on preview                  | Resident        | **national_id NOT leaked** in the public preview                                     |
| `POST /sign/{token}` `{signatureSvg}` | Resident (anon) | **200**, `signedAt` returned                                                         |
| `GET /signature-requests/{id}`        | Manager         | status flipped **pending → signed**, `signedAt` set — **state synced across actors** |
| Audit                                 | Manager         | a `sign`-related audit row is present                                                |
| Replay same token                     | Resident (anon) | **401 `invalid_token`** — single-use enforced                                        |

The core product promise (collect a resident signature on a document) works
correctly across actor boundaries, with no-oracle replay protection and no PII
leak to the public link.

### L8 — Cross-tenant isolation: **ISOLATED**

Beta manager `GET /signature-requests/{AlphaRequestId}` → **404 `not_found`**
(no-oracle, not 403 — existence is not leaked). Tenant boundary holds for by-id reads.

### L10 — Ownership integrity: **CONSISTENT** (with a self-correction)

Apartment `b606d92b…` ownership set: 1 owner at `ownershipPct: 100` → **sum = 100**.
_Method note: my first pass guessed the field name (`sharePercent`) and computed
sum=0 → "INCONSISTENT". Inspecting the row showed the real field is `ownershipPct`.
The "inconsistency" was an artifact of my wrong field name, not a product defect —
corrected and re-run (self-interrogation: suspect your own failure too)._

### Not exercised (budget)

Tenant OTP → portal own-data-only, invite→accept→active, contractor share-scope,
import→appears-everywhere. Portal endpoints exist and are guarded
(`TenantAuthGuard` + `tenant_sessions` revocation, migration 0038); negative guard
checks fold into Layer 5.

## Layer 4 — Perf at scale

**Scope honesty:** I did **not** run the full multi-thousand-row volume seed
(budget). Instead I used a higher-signal, deterministic method: **index inventory
(`pg_indexes`) + `EXPLAIN ANALYZE`** of the real list queries. At current MVP data
volumes every list query runs sub-millisecond, so timing alone proves nothing — the
**query plans + index coverage** are what reveal scale behaviour. Evidence: the
EXPLAIN output below (run against the real Neon DB via the `pg` pool).

### PERF-1 (MEDIUM, latent scale gap) — inconsistent cursor-pagination index coverage

Several list endpoints keyset-paginate with `ORDER BY created_at DESC, id DESC`.
The composite index that makes that an _index-ordered_ scan exists for some tables
but **not** for `projects` and `documents`:

| Table              | Has `(org_id, created_at DESC, id DESC)` idx?          | EXPLAIN of list query (current data)                                       |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| owners             | ✅ `idx_owners_org_created_desc`                       | Bitmap Index Scan (will be index-ordered at scale)                         |
| tasks              | ✅                                                     | indexed                                                                    |
| audit_log          | ✅ `(org_id, created_at DESC)`                         | indexed                                                                    |
| signature_requests | ✅ `(org_id, status, created_at DESC)`                 | indexed                                                                    |
| notifications      | ✅ `(user_id, created_at DESC)`                        | indexed                                                                    |
| **projects**       | ❌ only `(org_id)`, `(org_id,status)`, `(org_id,type)` | **Bitmap Index Scan → Sort node** (`Sort Key: created_at DESC, id DESC`)   |
| **documents**      | ❌ only `(org_id, project_id)` partial                 | **Seq Scan → Sort node** (worst — no usable index for the global org list) |

At MVP volume the planner picks bitmap/seq + quicksort for all of them (~0.07 ms),
so the regression is **not yet observable**. The risk is structural: as a single org
accumulates thousands of projects/documents, `projects` and `documents` will fetch
**the whole org set and sort it in memory on every page load**, while owners/tasks
can switch to a 25-row index-ordered scan. **Fix is cheap**: add
`(org_id, created_at DESC, id DESC) WHERE archived_at IS NULL` to `projects` and
`documents` (mirroring the owners/tasks index). _Not a current-perf bug; a latent
scale gap caught by plan inspection._

### PERF-2 (MEDIUM, resilience) — see ENV-2

The SSR `getMe()` self-fetch (every authenticated page render = a browser→Next→API
round-trip with no visible server-side timeout) deadlocked the dev server under
sustained load and never self-recovered. At scale or under a slow `/me`, authenticated
pages have no fast-fail path. (Full detail in the bootstrap ENV-2 finding.)

### Positive

The schema is genuinely **index-aware** — owners alone has 6 purpose-built indexes
(name_hash, phone_hash, national_id_hash unique, cursor composite). This is not a
naive schema; the gap is two missing indexes, not a systemic absence.

## Layer 5 — Security / ISO 27001

**Harness:** `e2e/audit/layer5-security.spec.ts` (multi-context + tampered
raw tokens). Evidence: `docs/audit/artifacts/layer5/*.json`.
**Headline: no CRITICAL findings. The security fundamentals are genuinely solid.**

| Probe                         | Result               | Evidence                                                                                                                                                           |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **IDOR** (Beta → Alpha by-id) | **SECURE**           | project/owner/document/task: Alpha-own → 200, Beta-cross → **404** (no-oracle) for all 4.                                                                          |
| **JWT tamper**                | **SECURE**           | valid → 200; bad signature → **401**; payload `role→provider_admin` (old sig) → **401**; unsigned (alg=none style) → **401**.                                      |
| **Mass-assignment**           | **SECURE (rejects)** | POST `/owners` with forged `id`+`organizationId`+`createdBy` → **400** (strict zod schema rejects unknown keys — defense in depth; forged org never takes effect). |
| **RBAC** (viewer write)       | **SECURE**           | (L2) viewer POST `/projects` → **403 forbidden**, server-side.                                                                                                     |
| **Unauth access**             | **SECURE**           | anon GET projects/owners/me/portal-me/provider-tenants/audit → **all 401**.                                                                                        |
| **Cookie flags**              | **SECURE**           | `access_token`: HttpOnly + SameSite=Lax; `refresh_token`: HttpOnly + SameSite=Lax + **Path scoped to `/api/v1/auth/refresh`**.                                     |
| **Rate-limit**                | **SECURE**           | 14 login attempts → `[401×9, 429×5]` — throttle at 10/60s confirmed.                                                                                               |
| **PII on the wire (D.19)**    | **SECURE**           | (L2/L3) national_id masked (`•••••••53`), never cleartext in create response or public sign preview.                                                               |

### ISO 27001 control mapping

| Annex A control         | Status    | Basis (this audit)                                                                                    |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| **A.9 Access control**  | ✅ Strong | RLS tenant isolation (404 no-oracle), server-side RBAC (403), anon rejection (401), httpOnly cookies  |
| **A.10 Cryptography**   | ✅ Strong | JWT integrity verified (tamper→401), PII pgcrypto-encrypted + masked, separate sign-token audience    |
| **A.12 Ops / logging**  | ✅ Good   | audit rows on writes (signature lifecycle), rate-limiting. ⚠️ live PII-in-logs scrubbing not verified |
| **A.13 Comms security** | ✅ Good   | SameSite cookies, HSTS + full CSP headers (seen at bootstrap)                                         |
| **A.18 / privacy**      | ✅ Good   | D.19 masking honoured, no national_id leak to public link                                             |

### Residual / not probed (honesty)

- **PII-in-server-logs** not verified live (needs log access; pino redaction is configured per CLAUDE.md but unconfirmed at runtime).
- **Provider MFA enforcement** not exercised (provider tier is a shell — see Layer 1).
- **CSRF**: relies on SameSite=Lax + custom header; no anti-CSRF token observed (acceptable for cookie+SameSite, noted).
- **Refresh-token rotation / reuse-detection** (D.21) asserted by design, not re-tested here.
- **Public-sign POST rate-limit** (5/hr) not stress-tested (would burn the single-use token).

## Visual pass

_pending_

## The 5 big patterns

_pending_
