# EMAPP — Progress Tracker

> Claude Code: READ THIS FIRST every session. Single source of truth

> for "where are we." Update after every task.

## Current Position

- **Phase:** 1 (Database)

- **Next task:** P1.2 — Tenancy Tables (organizations, users, memberships)

- **Status:** in_progress

- **Last completed:** P1.1

- **Blocked:** no

- **Branch:** phase-1

## Phase Completion Log

- [x] Phase 0 — Foundation (docs/04b) — 9/10 tasks done (P0.2 awaiting Infisical accounts; all others complete)

- [ ] Phase 1 — Database (docs/04c) — 1/14 tasks (P1.1 ✓)

- [ ] Phase 2 — Auth + Multi-tenant + Tenant SMS OTP (docs/03 §6)

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

- P1.1: PROVIDER_DATABASE_URL and PII_ENCRYPTION_KEY/PII_HASH_KEY are optional in db/src/env.ts for now. They become required when implementing P1.13 (withProvider) and P1.5 (PII encryption). Must add to Infisical before those tasks.

- P1.1: connection.ts removed; replaced by client.ts (pg Pool + drizzle/node-postgres). API health controller updated accordingly. Both use the `db` singleton directly; withTenant/withProvider wrappers in P1.13 will be the only external access path.

- P0.7: vite-tsconfig-paths v6 is ESM-only; vite 5 config loader uses CJS require(). Do NOT add it to vitest.config.ts — it causes a startup error. If path aliasing is needed in tests, use vitest's `resolve.alias` instead.

- P0.2 MANUAL FOLLOW-UP: User must create cloud accounts (Railway, Neon, Cloudflare R2, Resend, Sentry) and add secrets to Infisical. Until then, use SKIP_ENV_VALIDATION=true for local dev.

- P0.1: env is Node v24 / pnpm 11 (doc recommends Node 20; .nvmrc pinned to 20, engines >=20 — Node 24 satisfies). `packageManager` left at pnpm@9.0.0 per doc; install worked fine on pnpm 11.

- P0.1: fixed a corrupted .gitignore (it contained a literal PowerShell here-string command, not ignore rules).

- P0.1: added .gitattributes (eol=lf) — not in the doc checklist but required so the Husky shell hook doesn't break with CRLF on Windows.

- P0.1 MANUAL FOLLOW-UP for user: "Branch protection enabled on main" — GitHub Settings → Branches. Enable required status checks: typecheck, lint, test, build, secrets-scan, audit.

- P0.8 MANUAL FOLLOW-UP for user: CODEOWNERS uses @Urban-renewal/dev team. Create this GitHub team and add members, OR replace with individual GitHub usernames.
