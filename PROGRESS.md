# EMAPP — Progress Tracker

> Claude Code: READ THIS FIRST every session. Single source of truth

> for "where are we." Update after every task.

## Current Position

- **Phase:** 3 IN PROGRESS — Domain API (docs/03 §7), branch `phase-3` from up-to-date main. Slice-by-slice; one PR at phase end (user-approved cadence 2026-05-18). Agent scoping enforced in the SERVICE layer (project_assignments JOIN over withTenant), not an extra RLS policy (user-approved). FE design = FE-only, not an input to the API contract (user-confirmed 2026-05-18).

- **Next task:** Phase 3 Slice 3 — Apartments (via-parent building→project→org). Slices 1-2 DONE.

- **Status:** Slice 1 (Projects) CI-verified **8/8 green** (run 26046791639, draft PR #12). Slice 2 (Buildings) code + live conformance **65 passed / 1 skip** (auth+11 Projects+11 Buildings vs compiled API + Neon + RLS); pushed on PR #12. CI runs only on PRs to main → phase-3 PR opened as **draft** now (one PR, merged at phase end — cadence unchanged). Shared `common/keyset-cursor.ts` extracted (Projects refactored onto it). `@emapp/db` now exports `TenantTx` (typed tx for service helpers). D.24 recorded (high-scale stance: Neon pooler transaction-mode + per-slice index discipline; no schema denormalization / no Redis — locked stack; EXPLAIN as dev-helper not a CI gate).

- **Phase 3 doc-drift DECISION (recorded, no schema deviation):** the locked Phase-1 `projects` table has NO address/city/metadata (those are `buildings` columns) and the docs/09 §3.8 enriched list fields (`stats`/`contractor`/`last_activity_at`) depend on Phase-5 signatures + the shares slice. `@emapp/shared-types` `ProjectSchema` therefore reflects the REAL locked columns; docs/06 §4.3 "(template)" and docs/09 §3.8 stats are doc-drift, NOT a schema change (Gate-2 untouched). Validation error code stays `validation_error` system-wide (docs/09 "validation_failed" is doc-drift). `Idempotency-Key` (docs/09 §3.10) deferred to Phase 5 per the approved plan. Enrichment (stats/contractor) revisited after Slice 6 (shares) + Phase 5 (signatures).

- **Last completed:** P2-hardening — D.21 owned-auth rebuild + T2.10 Provider+MFA, black-box conformance **37/38 green** live (1 skip = P7 env-gated). Closed: signup atomicity, argon2id, hashed/rotating/reuse-detecting sessions, real logout, silent spec-flat lockout, per-IP throttle, JWT HS256+iss+aud, anti-enumeration, **stateless-JWT revocation hole (O3 — sid session-validity, 15s in-proc memo, flush on logout/reuse → immediate, zero UX cost)**. Provider tier: TOTP RFC6238, recovery codes, 30m/4h sessions, tier isolation. Medium audit findings closed; design gaps recorded as D.22 governed risk; D.21 propagated to CLAUDE.md/Doc07; secrets model reconciled.

- **Blocked:** no.

- **Branch:** phase-3 (phase-2-hardening merged to main; one PR at Phase-3 end)

## Phase Completion Log

- [x] Phase 0 — Foundation (docs/04b) — 9/10 tasks done (P0.2 awaiting Infisical accounts; all others complete)

- [x] Phase 1 — Database (docs/04c) — 14/14 tasks complete — merged

- [x] Phase 2 — Auth + Multi-tenant (docs/03 §6) — Org-user + Provider/MFA + Tenant SMS OTP INFRA all built (D.21 owned auth; OTP behind NoopSMSProvider, real 019/Inforu = governed Gate-4 swap). Earlier "OTP deferred" lines below are superseded by the 2026-05-18 hardening.

- [ ] Phase 3 — Domain API (docs/03 §7)

- [ ] Phase 4 — Documents (docs/03 §8)

- [ ] Phase 5 — Signatures (docs/03 §9)

- [ ] Phase 6 — Import (docs/03 §10)

- [ ] Phase 6.5 — Provider Admin tool (docs/03 §10.5)

- [ ] Phase 7 — Export (docs/03 §11)

- [ ] Phase 8 — Frontend polish + Tenant portal (docs/03 §12)

- [ ] Phase 9 — Quality + Launch (docs/03 §13)

## Task Log (newest first)

<!-- Claude appends: [YYYY-MM-DD HH:MM] P0.1 ✓ — note — commit <sha> -->

[2026-05-18] P2 complete (OTP deferred) ✓ — Tenant SMS OTP skipped by user decision; PR opened for Phase 2 Org-user auth.

[2026-05-18] P2 Org-user auth ✓ — Better Auth + JWT (15m access / 30d refresh) + cookie-based auth + AuthGuard/TenantGuard + AuthController (signup/login/refresh/logout/switch-org) + MeController + AuthModule + @fastify/cookie in main.ts + providerDb BYPASSRLS signup bootstrap (fixes users RLS chicken-and-egg) + Next.js login+signup pages + protected dashboard layout + i18n strings + 12 T2.x tests green. Gate 4 stop: must confirm Tenant SMS OTP rate-limit/OTP-expiry/provider config.

[2026-05-17] P1 spec-alignment ✓ — Reverted an unauthorized Gate-2/Gate-6 deviation (0010 buildings/apartments org_id denormalization) back to spec Template B (0011); closed pre-existing spec gaps: cache/env/withTenant to spec, verifyEncryptionStartup (P1.10), 0012 project_status→D.18, 0013 he_il_icu collation (D.11), 0014 audit_log→spec §12.4, 0015 signatures+documents→spec §4/P1.8/D.12. 52/52 T1.x green. — commit 9f27b25

[2026-05-17] P1.3-P1.14 ✓ — Full Phase 1: schema (collaboration/artifacts/share-permissions), migrations 0002-0009 (RLS policies, composite indexes, app_user grants), withTenant (SET LOCAL ROLE app_user), withProvider (provider_audit_log), 6 provider interfaces + impls, PII helpers, T1.5 (7 RLS tests) + T1.9 (3 rollback tests) all green. — commit a911ef8

[2026-05-17] P1.1 ✓ — Drizzle setup: pg client, T3-env, 6 pgEnums, bytea/citext/inet types, commonColumns/tenantColumns, full scaffold (schema/wrappers/audit/providers), placeholder T1.5-T1.9 tests. Removed connection.ts, updated API health controller. — commit 697b827

[2026-05-17] P0.10 ✓ — README.md (Quick Start + structure + commands), MIGRATION.md (4-stage growth playbook), CHANGELOG.md (v0.0.1 per Keep a Changelog). Tag v0.0.1-phase0 pushed. — commit TBD

[2026-05-17] P0.9 ✓ — docker-compose.yml (postgres/redis/minio/mailhog) + .dockerignore + SKIP_ENV_VALIDATION in api builder stage. Dockerfiles pre-existed from P0.4/P0.5. — commit c6d2c3d

[2026-05-17] P0.8 ✓ — GitHub Actions CI (6 parallel jobs), CODEOWNERS, PR template, Dependabot (npm + actions weekly). — commit df893de

[2026-05-17] P0.7 ✓ — Root vitest.config.ts + per-package configs (mergeConfig). V8 coverage (70% thresholds). @vitest/coverage-v8 + @vitest/ui at root. 23 tests green. — commit 81872f5

[2026-05-17] P0.6 ✓ — ESLint (@typescript-eslint/import/security/unicorn), Prettier, lint-staged, pre-commit hook (gitleaks). pnpm lint + typecheck green across all 6 packages. — commit 2dd0d39

[2026-05-17] P0.1 ✓ — Turborepo + pnpm monorepo skeleton, Husky + commitlint verified. — commit 9a25e4d

[2026-05-17] P0.2 ⏳ — .env.example committed, waiting for user to create accounts (Neon/Railway/Cloudflare/Resend/Sentry) and add secrets to Infisical.

[2026-05-17] P0.3 ✓ — 4 packages scaffolded: shared-types/db/config/validators. 21 validator tests green. — commit on phase-0

[2026-05-17] P0.5 ✓ — Next.js 15 App Router: RTL+Heebo, next-intl (he/en), shadcn Button, Sentry. — commit 3ca4894

[2026-05-17] P0.4 ✓ — NestJS 11+Fastify scaffold: health endpoint, Helmet CSP+HSTS, CORS, throttler, Sentry, pino. 2 smoke tests green. — commit 57075b8

## Notes / Surprises

<!-- Claude writes anything the next session must know -->

- P1 spec-alignment: PII_ENCRYPTION_KEY/PII_HASH_KEY are now REQUIRED `z.string().length(44)` in db/src/env.ts (spec §4). Added to Infisical **dev** 2026-05-17. STILL TO DO (§15.5): add distinct keys to Infisical **staging** and **production** before those envs run; keys must differ per environment and never be the dev value.

- DOC BUG (for the user to fix in docs/04c + docs/DECISIONS): doc 04c text and `_enums.ts` originally used project_status `permits/construction/archived`, which contradicts D.18 (LAW) `approved/in_construction/cancelled`. Code is now D.18-correct (migration 0012). The HTML doc text still says permits/construction/archived — update the doc so it matches D.18.

- TEST-INFRA DEBT — **RESOLVED 2026-05-18**: the concurrent-`migrate()` race (parallel T1.x workers each calling `setupTestDatabase()`) that flaked CI on every new migration is fixed properly: `packages/db/test/global-setup.ts` runs `migrate()` ONCE before any worker (wired via `vitest.config.ts` `globalSetup`); `setupTestDatabase()` is now a no-op. The one-off `apply-migration-*/fix-*/drop-*/check-extensions` scripts were deleted. **New migrations need NO special handling** — globalSetup applies them. (Was the recurring Phase-2 PR CI failure root cause.)

- Drizzle migrator tracks "applied" by journal `when` vs max `created_at` in `drizzle.__drizzle_migrations`. The one-off apply scripts insert `(hash=<tag>, created_at=<when>)`; this is enough to make the migrator skip them (it compares created_at, not the SHA256 content hash for the skip decision).

- GOTCHA (cost a debugging session 2026-05-18): a `.sql` file in `migrations/` is INVISIBLE to `drizzle migrate()` unless it also has an entry in `migrations/meta/_journal.json`. `0016_better_auth_tables.sql` was hand-written but its journal entry was never added, so `migrate()` printed "Migrations applied successfully" while silently skipping it → `ba_user` never created → every signup/login 500'd at the Better Auth `findUserByEmail` query. Fix committed (journal idx 16, `when` = 1779036600000 > idx 15 so it isn't skipped). **Rule: every NEW hand-written migration MUST get a `_journal.json` entry with a `when` greater than the previous max, or it will be silently ignored.**

- VERIFIED 2026-05-18: org-user signup works end-to-end against Neon dev (201, `{data:{user}}` envelope, access_token + refresh_token cookies). `providerDb` (neondb_owner) DOES bypass RLS on Neon — the earlier `organizations` INSERT failure was a PowerShell 5.1 artifact (non-UTF-8 `-Body` mangled Hebrew "בדיקה" → `?????`), NOT an RLS/app bug. To test Hebrew payloads from PS5.1, send `[Text.Encoding]::UTF8.GetBytes(...)` with `-ContentType "application/json; charset=utf-8"`.

- SPEC-ALIGNMENT 2026-05-18 (migration 0017): `audit_log.target_table` carried a legacy NOT NULL — 0003 created it as `entity_type NOT NULL`, 0014 renamed it to `target_table` (RENAME preserves NOT NULL) but never dropped it. The locked drizzle schema (artifacts.ts) defines it nullable; no-target actions (login/logout) need NULL. 0017 drops the NOT NULL. Login 500'd until 0017 was applied. Not a deviation — DB had drifted from the locked spec.

- VERIFIED 2026-05-18: login (200, `{data:{user}}`, cookies) and `/me` (200, full profile) work against Neon dev after 0017. `/me` without token → 401 `missing_token`. Refresh endpoint NOT yet confirmed via PS5.1: the `refresh_token` cookie is scoped `Path=/api/v1/auth/refresh` (correct, security-by-design) but .NET `CookieContainer` has an exact-path-match bug and won't resend it — real browsers do. Verify refresh via the frontend or by passing the cookie header manually.

- VERIFIED 2026-05-18 (curl + cookie jar, the reliable PS5.1 harness — use `curl.exe --data "@file.json"`, NEVER inline `-d` with spaces): full Phase 2 chain green — signup 201, duplicate 409 `email_taken`, wrong-pass 401 `invalid_credentials`, bad-body 400 `validation_error`, login 200, /me 200, /me-no-token 401, refresh 200 `{data:{ok:true}}`, logout 200. Automated: `@emapp/api` 12/12 (T2.1–T2.10 + smoke), typecheck 6/6, lint 6/6.

- OPEN ISSUE (intermittent, Phase 2 follow-up): signup on a FRESH email occasionally 500s on a long-running API process under sustained mixed load (carol, bob2 failed; test2/alice2/dave succeeded — all structurally identical). NOT a logic bug (unit tests green, fresh-process signups always 201). Smells like connection-pool state/exhaustion under load, OR a stale prepared-plan after the 0016/0017 DDL on pooled connections. When signUpEmail succeeds but the providerDb bootstrap throws, the ba_user is left ORPHANED (no cross-transaction rollback between Better Auth's connection and the providerDb tx) → next attempt on that email returns 409. Dev/non-prod 5xx responses now embed a `debug` cause-chain (pgcode/detail/hint) in the JSON body (commit 2993816) so the next occurrence is self-diagnosing — capture that `debug` block to root-cause. Robustness fix to consider: compensating ba_user delete on bootstrap failure.

- RESOLVED BY D.21 (2026-05-18, branch phase-2-hardening): the intermittent signup-500 / orphaned-account class is dissolved at the root — signup is now ONE `providerDb` transaction (org+user+membership+credential+audit+session). No second store ⇒ no cross-transaction orphan possible. Better Auth removed from the auth path entirely. Migration 0018 adds `auth_sessions` (SHA-256-hashed refresh, rotation, reuse-detection) + `users.failed_login_count/locked_until`. Black-box `auth.contract.spec.ts` is the conformance gate (contract-first).

- D.21 ACCEPTED SCOPED DEVIATION: auth bootstrap reads (`login`/`loadProfile`/session lookup) use the `db`/`providerDb` pool directly, NOT `withTenant`. This is inherent to authentication — there is no org context before a user is authenticated, so the "all reads via withTenant" rule cannot apply pre-auth. Reads are narrowly scoped (by user id / token hash) and hold no cross-tenant exposure. Documented here as the accepted, bounded exception.

- D.21 RESIDUALS (tracked, not blockers): (1) full anti-enumeration parity (identical body+timing for duplicate vs fresh signup) needs the magic-link email flow — blocked on Resend wiring (Phase 7); current build returns same 201 + neutral `{data:{ok:true}}` for duplicates (removes the 409/email_taken leak, residual = body shape differs). (2) T2.10 Provider Admin + mandatory MFA still NOT implemented — needs an explicit scope decision (implement now vs defer like Tenant OTP, recorded in DECISIONS/GATES).

- ACTION REQUIRED (Infisical-gated, user must run): `infisical run --env=dev -- pnpm --filter @emapp/db db:migrate` (applies 0018) then restart the API (`infisical run --env=dev -- pnpm --filter @emapp/api dev`). Then the black-box contract suite can be run for the live conformance verdict.

- T1.7 INTERPRETATION (2026-05-18): BUILD_LAYER_4 P1.14's literal "withTenant <2ms" = the RLS policy-evaluation overhead budget (Doc 02 §3.5), NOT wall-clock — a real withTenant call is ~4-5 round-trips and Neon RTT alone exceeds 2ms, so a sub-ms wall-time assertion is physically impossible and was never a real test. `t1-7-with-tenant-perf.spec.ts` instead pins a stable median/max regression guard on the full round-trip (catches missing-index/N+1/extra-round-trip regressions without flaking). The old "T1.7" label in multi-org.spec.ts was a mislabeled isolation test (now the real T1.7 exists).

- TRACKED DEBT (post-MVP, NOT a Phase-3 blocker): `AuthService` (~506 lines) violates SRP (signup orchestration + login + refresh-rotation + logout + switch-org + loadProfile + slug-gen + cookie policy + JWT signing + pg-error introspection) and DIP (inline `db` Drizzle queries instead of an injected, interface-typed repository; `session.repository.ts` is a loose `db:any` function module). The SMS provider IS correctly inverted (`@Inject(SMS_PROVIDER)`); apply the same to data access in a dedicated refactor. Deferred deliberately: a 506-line refactor on freshly-CI-green auth immediately before Phase 3 is high-blast-radius (cat-and-mouse risk) for marginal gain — schedule as its own gated workstream.

- FOLLOW-UP (tracked, ISO hardening, NOT a blocker): secrets-scan uses trufflehog `--only-verified`. Strengthen later (gitleaks job / drop --only-verified) — deferred deliberately: the CI test/conformance jobs contain intentional in-the-clear CI-only test credentials (ci.yml), so a broad scanner would false-positive and break CI. Do it with a tuned allowlist, not blindly. (Cross-phase audit finding.)

- DOC-DEBT (tracked, ISO-cosmetic): residual "Better Auth"/"bcrypt" prose remains in docs 01/02/03/04a/04b/05 (historical). Authoritative override = DECISIONS D.21 + CLAUDE.md (always-loaded, correct) + Doc07/Doc08 superseded banners + generated docs/09. A full 6-doc sweep is deferred to avoid churn/error; not misleading given the banners + D.21.

- P1.1: PROVIDER_DATABASE_URL is optional in db/src/env.ts (falls back to DATABASE_URL when unset).

- P1.1: connection.ts removed; replaced by client.ts (pg Pool + drizzle/node-postgres). API health controller updated accordingly. Both use the `db` singleton directly; withTenant/withProvider wrappers in P1.13 will be the only external access path.

- P0.7: vite-tsconfig-paths v6 is ESM-only; vite 5 config loader uses CJS require(). Do NOT add it to vitest.config.ts — it causes a startup error. If path aliasing is needed in tests, use vitest's `resolve.alias` instead.

- P0.2 MANUAL FOLLOW-UP: User must create cloud accounts (Railway, Neon, Cloudflare R2, Resend, Sentry) and add secrets to Infisical. Until then, use SKIP_ENV_VALIDATION=true for local dev.

- P0.1: env is Node v24 / pnpm 11 (doc recommends Node 20; .nvmrc pinned to 20, engines >=20 — Node 24 satisfies). `packageManager` left at pnpm@9.0.0 per doc; install worked fine on pnpm 11.

- P0.1: fixed a corrupted .gitignore (it contained a literal PowerShell here-string command, not ignore rules).

- P0.1: added .gitattributes (eol=lf) — not in the doc checklist but required so the Husky shell hook doesn't break with CRLF on Windows.

- P0.1 MANUAL FOLLOW-UP for user: "Branch protection enabled on main" — GitHub Settings → Branches. Enable required status checks: typecheck, lint, test, build, secrets-scan, audit.

- P0.8 MANUAL FOLLOW-UP for user: CODEOWNERS uses @Urban-renewal/dev team. Create this GitHub team and add members, OR replace with individual GitHub usernames.
