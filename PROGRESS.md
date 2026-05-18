# EMAPP — Progress Tracker

> Claude Code: READ THIS FIRST every session. Single source of truth

> for "where are we." Update after every task.

## Current Position

- **Phase:** 3 IN PROGRESS — Domain API (docs/03 §7), branch `phase-3` from up-to-date main. Slice-by-slice; one PR at phase end (user-approved cadence 2026-05-18). Agent scoping enforced in the SERVICE layer (project_assignments JOIN over withTenant), not an extra RLS policy (user-approved). FE design = FE-only, not an input to the API contract (user-confirmed 2026-05-18).

- **Next task:** Phase 3 COMPLETE — awaiting_approval. PR #12 un-drafted; STOP for user (end-of-phase gate). Slices 1-9 DONE. Live verification at HEAD: **167 conformance pass / 1 skip across 15 contract files** + **164 policy unit** + **36/36 live red-team** (see 2026-05-19 bullets). After merge: close **D.27 email-delivery remediation** (pre-Gate-5 obligation; Resend = Infisical-gated per Gate-4 SECRETS LAW) → then Phase 4 (Documents).

- **Status:** Phase 3 (Domain API) FEATURE-COMPLETE. 13 vertical slices: Projects, Buildings, Apartments, Owners (PII), Ownerships (atomic set, D.25), Contractors, Shares (strict JSONB), Tasks, Task-Assignees, Notifications (self), Notes, Audit-Read, Project-Assignments. All D.16 envelope / D.17 roles / keyset pagination / soft-delete / audit / locked-schema-faithful. 142 black-box conformance clauses pass live vs compiled API + Neon + RLS + pgcrypto + locked triggers. Decisions recorded: D.24 (scale stance), D.25 (ownership atomic set). Deferred & recorded (later phases, not gaps): contractor-facing share consume endpoint (needs Contractor auth tier), notification generation+SSE (Phase 5, T3.N.1; locked RLS forbids cross-user insert in actor tx), Documents (Phase 4), Signatures (Phase 5). Doc-drift recorded where docs/06+09 conflicted with the locked schema (no Gate-2 deviations).

- **Status flag:** awaiting_approval (Phase 3 end-of-phase gate per Autopilot).

- **Scale hardening (2026-05-19, user-directed; examine→plan→execute):** investigation CORRECTED two earlier "debts" (diagnosed from code, not memory): `statement_timeout` is ALREADY enforced at the pg pool (30s app / 60s provider) — earlier "(f) no statement_timeout" was FALSE; and the pools ARE explicitly sized (max 20/5 + timeouts), not defaults. Real, non-speculative deliverables shipped: (1) all connection knobs are now **env-tunable** (`DB_POOL_MAX`/`DB_PROVIDER_POOL_MAX`/`DB_POOL_IDLE_MS`/`DB_POOL_CONN_TIMEOUT_MS`/`DB_STATEMENT_TIMEOUT_MS`/`DB_PROVIDER_STATEMENT_TIMEOUT_MS`) with the current production-safe constants as HARD fallbacks (works under SKIP_ENV_VALIDATION/test; zero behaviour change at defaults) so ops tunes per-env / behind the pooler without a code change; (2) **k6 load harness** `load/k6-smoke.js` (ramping VUs, realistic 85/15 read/write mix, SLO thresholds that fail the run) + `load/README.md` operator runbook (the Neon transaction-pooler switch = lever #1, pool-sizing-behind-pooler guidance, the measure-then-decide rule, release gate). CORRECTED debt-list item (e): the nested-read double-query is **no-oracle-load-bearing** (the first lookup produces the 404 a foreign/unknown parent must get; deleting it = security regression) — optimization is "merge to ONE round-trip preserving 404", gated by k6 data, NOT a speculative rewrite. Verified: typecheck/lint green; full conformance 167 pass/1 skip (pool defaults unchanged → zero regression).

- **Live red-team + coverage matrix (2026-05-19, user-directed; think-like-attacker):** Local full-suite run first showed 121 "failures" — diagnosed FROM THE OUTPUT (not theory) as a harness/config artifact: the locally-booted API lacked `THROTTLE_TEST_BYPASS`, so the suite's signup burst hit the 100/min limiter (429). Re-booted the compiled API with `THROTTLE_TEST_BYPASS=contract-suite` (mirrors CI conformance job) → **167 pass / 1 skip / 15 files**; `policy.spec` **164/164**. (Lesson recorded: local full conformance run REQUIRES the server booted with the bypass env, exactly like ci.yml's conformance job; the contract suites already default the matching header.) New artifact `docs/TEST-COVERAGE-MATRIX.md` (13 entities × 7 angles, every cell → a test id; no blank cells). New reusable harness `apps/api/scripts/redteam.ts`: wipes ALL public-schema rows on dev (drizzle migration state preserved), provisions a clean controlled fixture over real HTTP (Org אלפא + Org ביתא, each {Manager,Agent,Viewer}; one Provider/MFA admin created directly to own the TOTP secret), then runs a 36-probe adversarial matrix (authN bypass incl. alg=none/wrong-secret JWT, cross-tenant IDOR no-oracle, D.17 privilege-escalation at RUNTIME, mass-assignment, PII non-leak, SQLi/NUL/malformed, idempotency replay+cross-tenant isolation, brute-force lockout w/o bypass, invite-token single-use/tamper, provider MFA accept/deny). **Result: 36/36 held, zero security defects.** One harness self-bug found & fixed (non-UUID Idempotency-Key → API correctly 400'd; product behaved right — fixed the harness, re-ran → 36/36). Dev DB now holds the clean fixture for further manual testing. Zero product code changed.

- **ISO audit-debt closure (2026-05-19, slices A/B/C — examine→plan→execute, user-directed):**
  - **A — audit IP/User-Agent (A.12.4):** AuditService merges a forensic-context default into every entry; CurrentUser decorator supplies trustProxy-aware ip + UA; 29 sites threaded; stored but NOT exposed in the Manager audit read; deterministic unit proof (4).
  - **B — Idempotency-Key:** optional-but-honoured (Stripe-style; required would break clients/conformance — recorded), concurrency-correct via atomic cache_kv claim; global interceptor (POST, non-auth); hardening H18.
  - **C — member provisioning + RUNTIME D.17 proof:** invite→accept (D.21 argon2id, invitee sets own password; withBootstrap scoped to manager org; one-time HS256 invite token iss/aud-pinned). `members` added to the D.26 policy (manager-only). NEW `members.contract.spec.ts` PROVES D.17 AT RUNTIME end-to-end: Viewer reads-only/all-writes-403, Agent sees ONLY assigned projects (404 no-oracle otherwise), invited Manager full, single-use invite, member_exists, self-lockout. **This converts the #1 ISO gap from static-only to runtime-proven.** Independent security review: 0 CRITICAL/0 HIGH; 2 MEDIUM → last-manager-lockout fixed (defence-in-depth; also structurally unreachable, recorded) + consent-gap governed as **D.27** (token-in-response interim; hard remediation gate = email delivery before Gate-5 prod).
  - Verified: typecheck/lint/api-docs green; policy proof 164 unit; audit-context 4 unit; full conformance **167 pass / 1 skip across 15 contract files** vs compiled api + neon + RLS + pgcrypto + locked triggers — zero regression across A+B+C.

- **D.26 (2026-05-18) — biggest ISO/A.9.4 gap STRUCTURALLY CLOSED (real fix, not a plaster):** D.17 authorization is now a SINGLE declarative policy (`apps/api/src/common/authz/policy.ts`) enforced by ONE fail-closed `AuthorizationGuard` (+`@AuthzResource`/`@AuthzAction`) on all 12 domain controllers, replacing ~13 scattered imperative checks. `policy.spec.ts` is the ISO verification artifact: an INDEPENDENT restatement of D.17 proves all 144 role×resource×action cells + 8 fail-closed guard-semantics — deterministic, zero-infra, CI `test` job. Verified: **152/152 proof** + full conformance **158 pass / 1 skip** with the guard live on every route (zero regression; manager paths unaffected). In-service `requireManager` kept as defense-in-depth, same matrix. Residual (recorded): runtime deny-proof for viewer/agent still needs a member-provisioning endpoint — now reduced to testing ONE guard, not scattered work; the control itself is documented+enforced+verified. See DECISIONS D.26.

- **Fresh-eyes hardening audit (2026-05-18, pre-merge, user-requested):** added `apps/api/src/modules/phase3-hardening.contract.spec.ts` — 16 black-box adversarial clauses (envelope/headers invariants, malformed JSON, wrong content-type, oversized strings, array-DoS bound, injection/XSS/unicode-RTL, numeric edges, verb confusion, cursor-abuse variants, ISO PII/secret non-leak, audit no-diff/ip/ua, SYSTEMATIC cross-tenant no-oracle matrix across projects/buildings/apartments/owners/tasks, concurrency duplicate-create race, CI-stable latency guard). It **caught 3 real defects**, all fixed at ROOT CAUSE (not plasters):
  1. **Malformed JSON → 500** (was: parser set statusCode=400 but GlobalExceptionFilter ignored non-HttpException status). Fix: filter now honours a carried 4xx on non-HttpException → clean D.16 `invalid_json`/`bad_request`. Single source (apps/api/src/common/filters/http-exception.filter.ts).
  2. **NUL / invalid-UTF-8 text → pg 22021 → 500.** Fix: ZodValidationPipe rejects NUL + unpaired surrogates as `validation_error` at the single input choke-point (covers EVERY endpoint, defense-in-depth) — never reaches pg. (apps/api/src/common/pipes/zod-validation.pipe.ts)
  3. **GET /owners/search captured by GET /owners/:id** → 401 (not a leak — uuid pipe/guard reject; no data, no 5xx). Test corrected to assert the true invariant (verb confusion never 2xx/5xx).
     Result: full conformance **158 pass / 1 skip across 14 contract files** (142 prior + 16 hardening) live vs compiled API + Neon + RLS + pgcrypto + locked triggers; zero regression from the global filter/pipe fixes. Error catalogue += invalid_json/bad_request.

- **Tracked debt from the audit — STATUS 2026-05-19:** (a) **CLOSED** by Slice C — D.17 deny-matrix for viewer/agent now black-box AND runtime-proven (`members.contract.spec.ts` + 36/36 red-team C1–C8). (b) **OPEN (recommended, not a blocker):** duplicated security-critical code across ~13 services (`isUniqueViolation` ×5, `requireManager`, `assertXVisible`) → extract one audited module. (c) **CLOSED** by Slice A — audit captures actor IP/User-Agent (ISO A.12.4). (d) **CLOSED** by Slice B — optional-but-honoured Idempotency-Key (red-team G1/G2 verified replay + cross-tenant isolation). (e) **OPEN (gated by k6 data; no-oracle-load-bearing — see scale bullet):** nested GET/list 2-query → merge to ONE round-trip preserving the 404. (f) **WAS FALSE / CLOSED:** `statement_timeout` is already enforced at the pg pool (30s/60s), now env-tunable. Remaining real debt = (b) + (e) only; both non-blocking, both recommended pre-Gate-5.

- **Slice 8 (Notes + Audit-Read) notes:** Notes org-scoped (direct RLS), optional project/apartment link (validated visible). manager/viewer read all org notes; agent sees own/org-level/assigned-project notes only; create = manager/agent (viewer forbidden); update/archive = manager or author. `is_pinned` (locked text col) exposed as boolean `pinned`. Audit-Read = APPEND-ONLY, Manager-only, org-scoped (audit_log RLS); projects who/what/target/when only — beforeState/afterState/ip/userAgent deliberately NOT exposed in the org view (sensitive; a future Provider-Admin cross-tenant view may surface more — recorded). No write endpoint (POST /audit → 404).

- **Slice 7 (Tasks + TaskAssignees + Notifications) notes:** Tasks org-scoped (direct RLS). D.17: manager full CRUD; viewer read-only; Agent sees ONLY assigned tasks (T3.T.1, service-layer JOIN on task_assignees) and may PATCH only status/description of their assigned tasks. status=completed sets completedAt/completedBy (cleared on revert). Assignees: manager add/remove, validated as active org members (memberships, revokedAt null) else 400 invalid_assignee; unique(task,user) → 409 assignee_exists. Notifications **self-scoped only** (locked RLS `org_id=app.organization_id AND user_id=app.user_id` — a user can only see/insert their OWN). Slice 7 = self read + mark-read/all. **DEFERRED & recorded (locked-RLS + spec-driven):** notification GENERATION on task-assign + SSE push is Phase 5 (T3.N.1 says exactly this) AND the locked notifications RLS forbids an actor inserting another user's notification in their tx — so cross-user notification creation is architecturally a Phase-5 concern (worker/recipient-context or DB trigger), not a Slice-7 gap. Agent-only task-scoping black-box fully exercised once user-invite endpoints exist (not in Phase 3) — service-layer enforced + recorded, same pattern as owners.

- **Slice 6 (Contractors + Shares) notes:** Contractors org-scoped CRUD (unique contactEmail/org → 409 contractor_exists). Shares = grant org→contractor→project, JSONB permissions validated by a shared-types `SharePermissionsSchema` that is BYTE-EQUIVALENT to the locked packages/db `_share-permissions.ts` (kept in sync; same pattern as auth.schemas; recorded). T3.S.1 verified: every perms object `.strict()` → unknown/nested-unknown keys → 400 validation_error (fail-closed). Share link is by `contractorId` (explicit FK) not docs/09 §3.14's `contractor_email` — avoids PII in grant call, matches Contractors slice (recorded doc-drift, no Gate-2 deviation). Lifecycle: contractor archivedAt; share revokedAt+revokedBy. DEFERRED & recorded: the contractor-FACING consumption endpoint docs/09 §3.14 `GET /contractor/projects/:id` needs the Contractor auth tier (share-token) which is NOT built in Phase 2 — this slice is manager-side grant management only; contractor-facing read is a later phase.

- **Slice 5 (Ownerships) DECISION D.25 (recorded; conforms to locked schema, no Gate-2 deviation):** Phase-1 migration 0002 `trg_ownerships_sum_check` (CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED) requires an apartment's ACTIVE shares to total 0 or EXACTLY 100 at COMMIT. Per-row add/patch/delete in separate withTenant txns is therefore physically impossible (a lone 50% insert → COMMIT raise → 500). ⇒ Slice-5 write API is an ATOMIC FULL-SET REPLACE: `PUT /api/v1/apartments/:apartmentId/ownerships {owners:[...]}` (empty = clear all; non-empty must sum to exactly 100; unique ownerId). Service ends all active rows + inserts the set in one tx; Zod refine + service guard → clean 400 ownership_sum_invalid; the deferred trigger raise is the authoritative backstop also mapped to 400 (never 500). Reads unchanged (GET …/ownerships active; GET …/owners masked owner+share, docs/09 §3.13). docs/09 §3.13's per-row POST/PATCH/DELETE shape is recorded DOC-DRIFT vs the locked trigger — surfaced to the user. This was found by the contract suite catching a real 500 (locked-invariant violation) — the test caught a genuine design defect, not a flake. Slices 1-3 CI 8/8 green; Slice 4 live conformance 89 pass/1 skip + security review clean (no CRITICAL/HIGH), CI pending on push. NOTE: local verification MUST kill any stale :3000 listener (PowerShell Get-NetTCPConnection→Stop-Process) before booting — pkill does not match the node process on Windows.

- **Slice 4 (Owners) DECISIONS (recorded, no Gate-2 deviation):** PII (national_id/phone) pgcrypto-encrypted at rest; API returns ONLY a masked suffix computed IN SQL via `pgp_sym_decrypt(..., current_setting('app.encryption_key'))` + `right(...,N)` → one round-trip, no N+1 decrypt (D.24), clear PII never leaves Postgres / never logged (pino redacts req.body.national_id/phone) / never in audit (name + changed-keys only). Israeli-ID MOD-10 checksum + phone E.164 validation layered in the BE DTO via @emapp/validators (shared-types stays pure). Owner LOOKUP = `POST /owners/search` with PII in the BODY (never URL/query) → HMAC match (T3.O.1). Owners are ORG-level (direct RLS); `ownership_pct` (docs/09 §3.13 Owner) belongs to ownerships (Slice 5) — omitted now, recorded. Agent project-scoping for bare owners deferred to Slice 5 (apartment-scoped owner views). Duplicate same-org national_id → 409 owner_exists (not an enumeration oracle — caller already authenticated in-org). Security review (general-purpose, read-only) on the diff: 0 CRITICAL / 0 HIGH; MEDIUM (pg detail leakage) already mitigated by GlobalExceptionFilter (generic body unless AUTH_DEBUG_ERRORS=1); LOW foot-gun (dummy national_id on phone-only update) FIXED — phone-only path uses encryptField/hashField directly.

- **Status:** Slice 1 (Projects) CI-verified **8/8 green** (run 26046791639, draft PR #12). Slice 2 (Buildings) code + live conformance **65 passed / 1 skip** (auth+11 Projects+11 Buildings vs compiled API + Neon + RLS); pushed on PR #12. CI runs only on PRs to main → phase-3 PR opened as **draft** now (one PR, merged at phase end — cadence unchanged). Shared `common/keyset-cursor.ts` extracted (Projects refactored onto it). `@emapp/db` now exports `TenantTx` (typed tx for service helpers). D.24 recorded (high-scale stance: Neon pooler transaction-mode + per-slice index discipline; no schema denormalization / no Redis — locked stack; EXPLAIN as dev-helper not a CI gate).

- **Phase 3 doc-drift DECISION (recorded, no schema deviation):** the locked Phase-1 `projects` table has NO address/city/metadata (those are `buildings` columns) and the docs/09 §3.8 enriched list fields (`stats`/`contractor`/`last_activity_at`) depend on Phase-5 signatures + the shares slice. `@emapp/shared-types` `ProjectSchema` therefore reflects the REAL locked columns; docs/06 §4.3 "(template)" and docs/09 §3.8 stats are doc-drift, NOT a schema change (Gate-2 untouched). Validation error code stays `validation_error` system-wide (docs/09 "validation_failed" is doc-drift). `Idempotency-Key` (docs/09 §3.10) deferred to Phase 5 per the approved plan. Enrichment (stats/contractor) revisited after Slice 6 (shares) + Phase 5 (signatures).

- **Last completed:** P2-hardening — D.21 owned-auth rebuild + T2.10 Provider+MFA, black-box conformance **37/38 green** live (1 skip = P7 env-gated). Closed: signup atomicity, argon2id, hashed/rotating/reuse-detecting sessions, real logout, silent spec-flat lockout, per-IP throttle, JWT HS256+iss+aud, anti-enumeration, **stateless-JWT revocation hole (O3 — sid session-validity, 15s in-proc memo, flush on logout/reuse → immediate, zero UX cost)**. Provider tier: TOTP RFC6238, recovery codes, 30m/4h sessions, tier isolation. Medium audit findings closed; design gaps recorded as D.22 governed risk; D.21 propagated to CLAUDE.md/Doc07; secrets model reconciled.

- **Blocked:** no.

- **Branch:** phase-3 (phase-2-hardening merged to main; one PR at Phase-3 end)

## Phase Completion Log

- [x] Phase 0 — Foundation (docs/04b) — 9/10 tasks done (P0.2 awaiting Infisical accounts; all others complete)

- [x] Phase 1 — Database (docs/04c) — 14/14 tasks complete — merged

- [x] Phase 2 — Auth + Multi-tenant (docs/03 §6) — Org-user + Provider/MFA + Tenant SMS OTP INFRA all built (D.21 owned auth; OTP behind NoopSMSProvider, real 019/Inforu = governed Gate-4 swap). Earlier "OTP deferred" lines below are superseded by the 2026-05-18 hardening.

- [x] Phase 3 — Domain API (docs/03 §7) — 13 slices feature-complete, CI 8/8, PR #12 — awaiting_approval

- [ ] Phase 4 — Documents (docs/03 §8)

- [ ] Phase 5 — Signatures (docs/03 §9)

- [ ] Phase 6 — Import (docs/03 §10)

- [ ] Phase 6.5 — Provider Admin tool (docs/03 §10.5)

- [ ] Phase 7 — Export (docs/03 §11)

- [ ] Phase 8 — Frontend polish + Tenant portal (docs/03 §12)

- [ ] Phase 9 — Quality + Launch (docs/03 §13)

## Task Log (newest first)

<!-- Claude appends: [YYYY-MM-DD HH:MM] P0.1 ✓ — note — commit <sha> -->

[2026-05-19] Phase-3 verification ✓ — full conformance re-run green (167/1-skip/15 files; 164 policy unit) after diagnosing the local 429s as a missing `THROTTLE_TEST_BYPASS` server env (harness/config, not a product bug). Added docs/TEST-COVERAGE-MATRIX.md (13×7, no blank cells) + apps/api/scripts/redteam.ts (DB wipe → clean 2-org+provider fixture → 36-probe attacker matrix: 36/36 held, zero defects). Tracker sync: PROGRESS debt-list reconciled (a/c/d/f CLOSED, b/e remain non-blocking), GATES Gate-6 log records D.24–D.27 + D.27 pre-Gate-5 email obligation. — commit TBD

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
