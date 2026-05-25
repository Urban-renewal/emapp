# QA Manual Findings — Phase 4a Manager Web

> **POST-PASS RE-CHARACTERIZATION (added later same day).** The 360 ms "baseline floor" and the 1.7 s `/projects` TTFB measured below are **geographic, not algorithmic**. The dev DB lives in Neon `us-east-1` (Virginia, IP 52.4.160.253); the QA was run from Israel. Direct TLS handshake to that host measured **360 ms per round-trip**, exactly matching the per-request floor.
>
> In production (Railway + Neon in the same region), per-RTT cost is ~1-5 ms. Projected production numbers:
>
> | Endpoint                    | Localhost QA (Israel→VA) | Production estimate               |
> | --------------------------- | ------------------------ | --------------------------------- |
> | `/api/v1/health`            | 360 ms                   | 5-15 ms (no DB ping after PR #54) |
> | `/api/v1/ready`             | 362 ms                   | 20-30 ms (DB ping = 1-5 ms RTT)   |
> | `/api/v1/projects?limit=25` | 1767 ms                  | 30-80 ms (4 RTs × 1-5 ms + query) |
>
> **Implications:**
>
> - PR #54 (liveness ≠ readiness) is still correct architecture, but the headline 40 % speedup is mostly a localhost artefact. In prod the win is ~5-15 ms — the architectural correctness (no DB-flake-induced restarts) remains the real value.
> - **F-PERF-1 (projects 1767 ms) is most likely NOT a production issue.** The 4-RT cost in `withTenant` is geography-amplified locally; in prod the same 4 RTs cost 4-20 ms total. Deferred work on `withTenant` should wait until profiling against production data confirms there's an actual problem.
> - If a real production user complains about latency, look for: FE bundle size + Heebo font load, cache invalidation, a single endpoint doing N+1 / table scan, or Railway cold-start with <2 instances. Not the DB ping or RLS GUC overhead.
> - The QA pass itself is still useful — it confirmed security headers, anti-enumeration, no PII leaks, SSR form `method="post"`, and the locale middleware. Those are correctness checks that don't depend on RTT.
>
> See `FE-BUNDLE-AUDIT.md` for the follow-up FE-side investigation (result: bundle is healthy; suspects shifted to double-fetch waterfall / CF Pages cold-start / N+1 against populated data).

**Date:** 2026-05-25
**Tester:** Claude (manual click-by-click + 5-axis: Network / Console / Cookies / Server log / DB)
**Branch:** `audit-v1-1-closures-worktree` (post Audit v1.1 closures)
**Test org:** "QA Test Org" / "QA Tester" / qa-tester@emapp.test (created during run)
**Servers:** API :3000 (NestJS+Fastify), Web :3001 (Next.js dev)

---

## TL;DR

| Severity     | #        | Domain           | Headline                                                                                                                                                                      |
| ------------ | -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH         | F-PERF-1 | API perf         | `/api/v1/projects?limit=25` TTFB **1767 ms** on empty tenant (warm cache). Other list endpoints 800–1200 ms.                                                                  |
| HIGH         | F-PERF-2 | API base cost    | `/api/v1/health` baseline **360 ms** TTFB — every request pays Neon DB round-trip. Customer-felt latency floor.                                                               |
| MED          | F-STAB-1 | Web stability    | Next.js dev server crashed once mid-navigation to `/imports`. Not reproduced on retry. Dev-mode HMR suspect.                                                                  |
| MED          | F-UX-1   | Session          | After web restart, `/he/login` rendered with sidebar/topbar of an unrelated prior user ("Alpha / מיכל מנהלת"). Cookie+session resolution boundary issue. Worth a second look. |
| LOW          | F-DEV-1  | Dev DX           | RSC cold-compile first hit 1.5–4 s per route (`/imports?_rsc=…` 4.1 s, `/projects?_rsc=…` 169 ms warm). Acceptable dev artefact; should be invisible in prod build.           |
| **POSITIVE** | P-SEC-1  | Security headers | Strict CSP, HSTS preload, X-Frame=SAMEORIGIN, X-CTO=nosniff, Referrer=no-referrer, COOP/CORP, rate-limit hdrs — **all present** on every API response.                        |
| **POSITIVE** | P-AUTH-1 | Auth             | `/api/v1/me` without token → `401 {error: {code: 'missing_token'}}`. No PII leak in error envelope.                                                                           |
| **POSITIVE** | P-UX-1   | Sidebar nav      | Sidebar highlight follows route, no console errors during normal navs, no PII or token in URL after any nav.                                                                  |

---

## F-PERF-1 — Empty-list endpoint TTFB is the customer-felt latency

**Measured (warm cache, empty tenant, localhost, Neon DB):**

| Endpoint                        | TTFB              | Total dur               | h1 rendered      |
| ------------------------------- | ----------------- | ----------------------- | ---------------- |
| `GET /api/v1/projects?limit=25` | **1767 ms**       | 1773 ms                 | "פרויקטים"       |
| `GET /api/v1/owners?limit=25`   | ~1180 ms          | 1217 ms                 | "בעלי דירות"     |
| `GET /api/v1/imports?limit=25`  | ~800 ms           | 825 ms                  | "ייבוא"          |
| `GET /api/v1/me`                | 180–340 ms warm   | (mostly cached/me-poll) | —                |
| `GET /api/v1/health`            | **360 ms steady** | 360 ms                  | (baseline floor) |

**Interpretation:**

- The **360 ms floor** is the Neon round-trip cost for every request — likely the `db.ping()` inside `AppController#health` + JWT verify + global interceptors. Pricing-wise: on every request the user waits ~360 ms before any business logic runs.
- The `/projects` endpoint adds **+1.4 s on top** of that floor for an **empty** list. That points at:
  - `withTenant` issuing `SET LOCAL app.tenant_id` + `SET LOCAL row_security` on a fresh pool connection each time — Neon connection-checkout cost.
  - Possible N+1 in the projects query if it joins building/apartment counts.
  - Drizzle's `.select({...}).from(projects).where(eq(orgId, …))` plus implicit count for cursor.
- User stated explicitly: _"השקעתי הרבה כדי שללקוח יהיה אפשרות לא להמתין בכלל"_. The current floor is too high to meet that bar.

**Suggested next step (not done in this QA pass):**

1. Profile a single `/api/v1/projects` cold and warm with `pg_stat_statements` to identify whether the cost is connection-checkout, RLS GUC, or query plan.
2. Consider connection pinning per request (already done via `withTenant`?) vs pool warm-up.
3. If `withTenant` opens a new connection per call → that's the root. Solution: pgbouncer transaction pooling + `SET LOCAL`.
4. Health endpoint: drop the `db.ping()` (or move it to a periodic /readyz with separate cadence) → /health becomes <10 ms.

---

## F-PERF-2 — Baseline 360 ms is the latency floor

See F-PERF-1. Every request pays 360 ms before user code runs. Health endpoint with no auth, no work, returns:

```json
{ "status": "ok", "db": "connected", "uptime": 865, "timestamp": "…" }
```

The `db:connected` field implies an actual DB ping on the request thread. That's the single biggest latency win available — separating liveness from readiness.

---

## F-STAB-1 — Web dev server crashed mid-navigation (one-off)

**Repro:** Click sidebar "ייבוא" (Imports) immediately after multiple other navigations.
**Result:** `http://localhost:3001/imports` (no locale) → ERR_CONNECTION_REFUSED. `netstat` showed nothing on :3001. Process was gone.
**Recovery:** `preview_start web` brought it back. Subsequent clicks on Imports worked normally (`/he/imports` rendered in 4 s incl. cold RSC compile).
**Hypothesis:** Next.js Fast Refresh died on a build error mid-batch. The hard reload to `/imports` (locale-less) triggered the user-visible failure.
**Action:** Cannot reproduce; documented for future watch. If it recurs in prod, would be a release blocker.

---

## F-UX-1 — Session ambiguity after server restart — RESOLVED (measurement artifact)

**Post-investigation note:** `apps/web/src/middleware.ts` lines 60-66 redirect authenticated users from `/he/login` to `/he`. My JS measurement caught `location.pathname` at `/he/login` BEFORE the redirect fired; the screenshot caught the AFTER state (`/he` dashboard with the legitimately-logged-in "Alpha / מיכל" pre-existing dev session). The topbar/body mismatch was a timing artifact, not a layout boundary bug. The `(auth)` and `(dashboard)` route groups have separate layouts and cannot leak across each other.

**Original observation (preserved for the record):**

**What I saw:**

- Logged in as **QA Tester / QA Test Org** via /he/signup.
- Web server crashed mid-test.
- After `preview_start web`, navigated to `/he/login`.
- `document.cookie.length > 0` confirmed cookies persisted (httpOnly cookies live in browser, not the dev server).
- Page rendered the **login form** (per `find` accessibility tree)…
- …but topbar showed **"מיכל מנהלת" / "Alpha"** — a different user from a prior session.

**Concerning angle:** A logged-in browser should never see another user's profile in the topbar while the body is the login form. The page shell is reading session state from somewhere that says "Alpha", while the body decided "no auth, show login".

**Likely-benign explanation:** Two race-y `getCurrentUser()` calls — one cached SSR result from an earlier render, one fresh middleware check that found the QA Tester session expired/wiped. Header layout used the stale.

**Action:** Worth a follow-up read of the layout's auth check vs middleware's. If the topbar can ever display user X's name while the route belongs to user Y, that's a confidentiality-of-display issue (would surface in screenshot-mediated attacks).

---

## F-DEV-1 — RSC cold-compile cost

| Route               | RSC dur      | API dur                 | Note                      |
| ------------------- | ------------ | ----------------------- | ------------------------- |
| `/he/projects` cold | 169 ms (RSC) | 2308 ms (API)           | First nav after login     |
| `/he/projects` warm | 169 ms       | 1757 ms                 | Warm cache (same payload) |
| `/he/imports` cold  | **4107 ms**  | 825 ms                  | First Imports compile     |
| `/he/owners` cold   | n/a          | 1217 ms (API dominated) |                           |

RSC cost is dev-only (Next.js JIT compile). Will not affect prod (Cloudflare Pages static build). Documented for completeness.

---

## POSITIVES (verified during QA)

- **CSP**: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src … r2.cloudflarestorage.com …; connect-src … sentry.io api.resend.com r2.cloudflarestorage.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src-attr 'none'; upgrade-insecure-requests` — locked down, no inline scripts allowed, no wildcards in connect-src.
- **HSTS**: `max-age=31536000; includeSubDomains; preload` ✓
- **No PII or token in URL** after sign-up, login, or sidebar navigation (URL inspected on each step).
- **Sign-up flow**: POST `/api/v1/auth/signup` → **201 Created**; dashboard renders after redirect.
- **Logout button** present in topbar (`התנתק`).
- **Locale middleware**: both `/imports` and `/he/imports` resolve correctly (when unauthenticated they redirect to `/he/login` with 307; when authenticated they reach the route).
- **Rate limit headers**: `x-ratelimit-limit: 100 / x-ratelimit-remaining: 99 / x-ratelimit-reset: 60` — throttler effective on every API response.

---

## Coverage gaps (what I did NOT do in this pass)

- QA-3 (Login → logout → mid-session 401 → redirect) — only signup+nav covered.
- QA-5 (Submit a real form: create project / owner / signature request) — not exercised; would require a verified phone or seed data.
- QA-6 deep adversarial — only headers + URL/cookie inspection done. View-source check on login page not redone post-Audit-v1.1.
- Apartment / Building nested routes — not visited.
- Mobile / RTL viewport / accessibility — not tested.

---

## Cleanup

- Test org `QA Test Org` (email `qa-tester@emapp.test`) and its `auth_sessions` rows remain in dev DB. Owner of dev DB can wipe via the org_archived/cascade path or direct DELETE.
- Servers: API still running on :3000 (separate process, PID 36772 at start of session). Web :3001 restarted once; final state running under serverId `46e3b0ca-5fe7-4f93-bd39-6547d707be5f`.
