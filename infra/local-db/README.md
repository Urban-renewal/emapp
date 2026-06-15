# Local dev Postgres (the #1 perf lever)

**Why:** the dev Neon DB lives in us-east-1 → ~165 ms per query from Israel →
1.2–1.5 s per authenticated request and 30–60 s test files (V12 perf diagnosis,
ledger 2026-06-12). A local Postgres brings that to <1 ms/query (measured: `/me`
~134 ms vs ~1 s, owners ~229 ms vs ~1.8 s).

## Selecting local: the `DB_TARGET` flag (single source of truth)

How the app loads the database is one env flag, resolved by
`packages/db/src/db-target.ts`. Every connection-opener (app pool, provider
pool, migrator, pg-boss) reads through it — they can never split onto different
databases.

```
DB_TARGET=local
LOCAL_DATABASE_URL=<your local Postgres URL>
```

`LOCAL_DATABASE_URL` is whatever local PG you run — pick ONE:

| How you got local PG                                                               | `LOCAL_DATABASE_URL`                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Native install** (default; what `docs/LOCAL-DEV.md` + `start-dev-local.ps1` use) | `postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable` |
| **Docker kit** (`docker compose -f docker-compose.dev.yml up -d`, binds `:5433`)   | `postgresql://emapp@localhost:5433/emapp`                         |

> Do NOT change Infisical's `DATABASE_URL` — Neon stays the team default
> (`DB_TARGET` unset → `neon`). `DB_TARGET` / `LOCAL_DATABASE_URL` are NOT
> Infisical secrets, so setting them locally passes through the injection.

## Commands

```bash
# migrate the local DB (resolver routes the migrator at LOCAL_DATABASE_URL,
# NOT Infisical's Neon DATABASE_MIGRATE_URL — that was the silent-migrate-Neon
# trap before the flag). Defaults to the native :5432 URL; override by exporting
# LOCAL_DATABASE_URL first.
pnpm db:local:migrate

# run the whole stack on local (sets DB_TARGET=local + LOCAL_DATABASE_URL):
powershell -ExecutionPolicy Bypass -File .\start-dev-local.ps1
```

`db:local:migrate` routes through `infisical run --env=dev` so the mandatory PII
keys reach the migrate runner. Fresh DB = no seed data → `pnpm --filter @emapp/db
seed:dev` (also via the flag). See `docs/LOCAL-DEV.md` for the full walkthrough +
the 6-role login credentials.

## Docker kit note (opt-in, unverified)

`docker-compose.dev.yml` provisions PG16+ICU on `:5433` (passwordless `emapp`
role). It was authored 2026-06-12 but **never runtime-verified** (Docker Desktop
wasn't installed on the dev machine). The native :5432 install is the
runtime-proven path; the Docker kit is an alternative for a clean reproducible
container — point `LOCAL_DATABASE_URL` at `:5433` if you use it.
