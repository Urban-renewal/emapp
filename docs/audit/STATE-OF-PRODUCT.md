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

_pending_

## Layer 3 — Cross-actor lifecycle + sync

_pending_

## Layer 4 — Perf at scale

_pending_

## Layer 5 — Security / ISO 27001

_pending_

## Visual pass

_pending_

## The 5 big patterns

_pending_
