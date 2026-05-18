# @emapp/db

Drizzle ORM schema, migrations, DB pools, and the tenant/provider access wrappers.

## Hard rules (from root CLAUDE.md)

- NEVER call `db.query` / `db.select` directly from app/controller code.
- Every customer-data read MUST go through `withTenant(orgId, fn)` or
  `withProvider(providerUserId, reason, fn)`.
- `withBootstrap(fn)` is the ONLY sanctioned RLS-bypass — first-org signup
  bootstrap ONLY (D.21); it MUST write its audit rows inside the same tx.
- Auth bootstrap reads (login / loadProfile / session-validity) use the
  `db` pool directly by necessity (no org context pre-auth) — a documented,
  bounded exception (D.21 / PROGRESS).
- PII columns (`national_id`, `phone`, signature blobs) are pgcrypto-encrypted
  via `encryptField`/`decryptField` (key = env.PII_ENCRYPTION_KEY) — never log.

## Files (current — post Phase 1 + D.21)

- `src/client.ts` — pg `pool` (app, RLS via app_user) + `providerPool`
  (BYPASSRLS) + drizzle instances. (There is NO `connection.ts`.)
- `src/env.ts` — T3-env; `skipValidation` when SKIP_ENV_VALIDATION or
  NODE_ENV=test.
- `src/wrappers/with-tenant.ts` · `with-provider.ts` · `with-bootstrap.ts`.
- `src/schema/` — tables. Incl. `auth-sessions.ts` (org refresh, hashed) &
  `provider-sessions.ts` (D.21/T2.10). `auth.ts` (ba\_\* Better Auth tables) is
  DEPRECATED/dead — Better Auth removed from the auth path (D.21).
- `src/audit/audit.service.ts` — append-only `audit_log` writer.
- `migrations/` — SQL migrations. Some are GENERATED (drizzle-kit), many are
  HAND-WRITTEN (e.g. 0016–0019: RLS/auth infra). Hand-written ones MUST get a
  `meta/_journal.json` entry with a `when` greater than the previous max or
  the migrator silently skips them.
- `test/global-setup.ts` — vitest globalSetup runs `migrate()` ONCE before
  workers (fixed the concurrent-migrate CI race; no per-migration scripts).
- `drizzle.config.ts` — drizzle-kit config, reads `DATABASE_URL`.

## Commands

```
pnpm db:generate   # generate migration SQL from schema changes
pnpm db:migrate    # apply pending migrations (tsx scripts/migrate.ts)
```
