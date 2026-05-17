# @emapp/db

Drizzle ORM schema, migrations, and DB connection pool.

## Hard rules (from CLAUDE.md root)
- NEVER call `db.query` / `db.select` directly from outside this package.
- Every read MUST go through `withTenant(orgId, fn)` or `withProvider(providerUserId, reason, fn)`.
- Both wrappers live in `src/tenant.ts` (added Phase 1).
- PII columns (`national_id`, `phone`, `signature_blob`) are encrypted via pgcrypto — never log them.

## Files
- `src/connection.ts` — postgres pool + drizzle instance.
- `src/schema/` — Drizzle table definitions (added Phase 1).
- `migrations/` — generated SQL migrations, never hand-edit.
- `drizzle.config.ts` — drizzle-kit config, reads `DATABASE_URL` from env.

## Commands
```
pnpm db:generate   # generate migration SQL from schema changes
pnpm db:migrate    # apply pending migrations
```
