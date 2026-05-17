# EMAPP — Progress Tracker

> Claude Code: READ THIS FIRST every session. Single source of truth

> for "where are we." Update after every task.

## Current Position

- **Phase:** 2 complete (Org-user auth) — Tenant SMS OTP deferred by user decision

- **Next task:** Phase 3 — Domain API (after PR merge)

- **Status:** awaiting_approval

- **Last completed:** P2 Org-user auth — Better Auth + JWT + refresh tokens + guards + frontend login/signup

- **Blocked:** no

- **Branch:** phase-2

## Phase Completion Log

- [x] Phase 0 — Foundation (docs/04b) — 9/10 tasks done (P0.2 awaiting Infisical accounts; all others complete)

- [x] Phase 1 — Database (docs/04c) — 14/14 tasks complete — merged

- [x] Phase 2 — Auth + Multi-tenant (docs/03 §6) — Org-user tier complete; Tenant SMS OTP intentionally deferred (user decision 2026-05-18)

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

- TEST-INFRA DEBT (Phase 1 follow-up): vitest runs the 9 T1.x spec files in parallel; each calls `setupTestDatabase()` → concurrent drizzle `migrate()`. New migrations race (TOCTOU on catalog/DDL even with IF EXISTS guards). Current workaround: apply new migrations once serially via `scripts/apply-migration-00NN.ts` (which also inserts drizzle tracking rows so the migrator no-ops). Proper fix: a vitest `globalSetup` that runs migrations once before workers; then delete the one-off apply scripts. Until then, every NEW migration needs a serial apply script run before `pnpm test`.

- Drizzle migrator tracks "applied" by journal `when` vs max `created_at` in `drizzle.__drizzle_migrations`. The one-off apply scripts insert `(hash=<tag>, created_at=<when>)`; this is enough to make the migrator skip them (it compares created_at, not the SHA256 content hash for the skip decision).

- GOTCHA (cost a debugging session 2026-05-18): a `.sql` file in `migrations/` is INVISIBLE to `drizzle migrate()` unless it also has an entry in `migrations/meta/_journal.json`. `0016_better_auth_tables.sql` was hand-written but its journal entry was never added, so `migrate()` printed "Migrations applied successfully" while silently skipping it → `ba_user` never created → every signup/login 500'd at the Better Auth `findUserByEmail` query. Fix committed (journal idx 16, `when` = 1779036600000 > idx 15 so it isn't skipped). **Rule: every NEW hand-written migration MUST get a `_journal.json` entry with a `when` greater than the previous max, or it will be silently ignored.**

- VERIFIED 2026-05-18: org-user signup works end-to-end against Neon dev (201, `{data:{user}}` envelope, access_token + refresh_token cookies). `providerDb` (neondb_owner) DOES bypass RLS on Neon — the earlier `organizations` INSERT failure was a PowerShell 5.1 artifact (non-UTF-8 `-Body` mangled Hebrew "בדיקה" → `?????`), NOT an RLS/app bug. To test Hebrew payloads from PS5.1, send `[Text.Encoding]::UTF8.GetBytes(...)` with `-ContentType "application/json; charset=utf-8"`.

- P1.1: PROVIDER_DATABASE_URL is optional in db/src/env.ts (falls back to DATABASE_URL when unset).

- P1.1: connection.ts removed; replaced by client.ts (pg Pool + drizzle/node-postgres). API health controller updated accordingly. Both use the `db` singleton directly; withTenant/withProvider wrappers in P1.13 will be the only external access path.

- P0.7: vite-tsconfig-paths v6 is ESM-only; vite 5 config loader uses CJS require(). Do NOT add it to vitest.config.ts — it causes a startup error. If path aliasing is needed in tests, use vitest's `resolve.alias` instead.

- P0.2 MANUAL FOLLOW-UP: User must create cloud accounts (Railway, Neon, Cloudflare R2, Resend, Sentry) and add secrets to Infisical. Until then, use SKIP_ENV_VALIDATION=true for local dev.

- P0.1: env is Node v24 / pnpm 11 (doc recommends Node 20; .nvmrc pinned to 20, engines >=20 — Node 24 satisfies). `packageManager` left at pnpm@9.0.0 per doc; install worked fine on pnpm 11.

- P0.1: fixed a corrupted .gitignore (it contained a literal PowerShell here-string command, not ignore rules).

- P0.1: added .gitattributes (eol=lf) — not in the doc checklist but required so the Husky shell hook doesn't break with CRLF on Windows.

- P0.1 MANUAL FOLLOW-UP for user: "Branch protection enabled on main" — GitHub Settings → Branches. Enable required status checks: typecheck, lint, test, build, secrets-scan, audit.

- P0.8 MANUAL FOLLOW-UP for user: CODEOWNERS uses @Urban-renewal/dev team. Create this GitHub team and add members, OR replace with individual GitHub usernames.
