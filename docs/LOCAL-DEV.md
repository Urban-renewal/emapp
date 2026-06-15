# Local Development Environment

> How to run EMAPP fully locally — fast (local Postgres, ~1 ms round-trips) and
> with frictionless auth for all 6 roles. Set up 2026-06-02. If you are a new
> agent and the app "feels broken" (slow, login fails, empty data), **read this
> first** — most of that is environment, not code.

## TL;DR

```powershell
# 1. one-time: a local Postgres 16+ on :5432, db `emapp`, password `1234`
# 2. apply schema + seed
infisical run --env dev -- powershell -NoProfile -ExecutionPolicy Bypass -File .\seed-demo-local.ps1   # rich demo data (optional)
# 3. run the whole stack on the LOCAL db
powershell -ExecutionPolicy Bypass -File .\start-dev-local.ps1
# 4. open http://localhost:3001
```

## Choosing the database: the `DB_TARGET` flag

How the app loads the database is selected by ONE env flag — no per-URL
juggling. The resolver lives in `packages/db/src/db-target.ts` and every
connection-opener (the app pool, the provider/BYPASSRLS pool, the migrator, and
pg-boss in both the API and the worker) reads through it, so they can never
drift onto different databases.

| `DB_TARGET`             | reads                                                                         | used for                             |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| `neon` (default, unset) | `DATABASE_URL` + `PROVIDER_DATABASE_URL` + `DATABASE_MIGRATE_URL` (Infisical) | the shared team DB (us-east-1)       |
| `local`                 | `LOCAL_DATABASE_URL`                                                          | the Postgres on your machine (~1 ms) |

Switching is one variable. Adding a future managed-Postgres service is one entry
in `DB_TARGETS` + one resolver strategy — **no consumer changes** (Open/Closed).

```powershell
# run the whole stack on the LOCAL db:
$env:DB_TARGET = 'local'
$env:LOCAL_DATABASE_URL = 'postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable'
# (start-dev-local.ps1 sets both for you, AFTER Infisical injection)

# migrate the LOCAL db (resolver routes the migrator at LOCAL_DATABASE_URL,
# NOT Infisical's Neon DATABASE_MIGRATE_URL):
pnpm db:local:migrate
```

## Why local Postgres (the #1 perf lever)

Infisical's dev `DATABASE_URL` points at **remote Neon (us-east-1)**. Every
request makes 5–6 `withTenant` round-trips; at ~180 ms RTT that's **~1 s+ per
click**. A local Postgres drops the RTT to ~1 ms, so `/me` goes from ~1.4 s to
~0.2 s. The slowness you may have heard about was the DB, **not** the FE proxy
(that hop costs single-digit ms — see `apps/web/src/app/api/[...path]/route.ts`).

## The launcher scripts (gitignored — they hold the local DB password)

These live at the repo root and are in `.gitignore`. Re-create them if missing:

### `start-dev-local.ps1`

```powershell
param([switch]$Inner)
if ($Inner) {
  # Runs INSIDE `infisical run` — set AFTER injection so it wins. THIS is the
  # crux: setting these before `infisical run` does NOT work for Infisical-owned
  # vars. DB_TARGET + LOCAL_DATABASE_URL are NOT Infisical secrets, so they pass
  # through; the db-target resolver routes every connection at the local DB.
  $env:DB_TARGET = 'local'
  $env:LOCAL_DATABASE_URL = 'postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable'
  $env:DEV_AUTH_BYPASS = '1'      # enables the fixed dev code 000000 (see below)
  pnpm dev
} else {
  infisical run --env dev -- powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Inner
}
```

Run: `powershell -ExecutionPolicy Bypass -File .\start-dev-local.ps1`

> ⚠️ Always launch with this script. A manual `$env:DATABASE_URL=…; infisical run -- pnpm dev`
> connects the API to **remote Neon** (Infisical wins), so your local seed +
> local provider account won't exist and logins will appear broken.

### `mfa-code.ps1` (only if you bootstrap a provider with a real authenticator)

Prints the current TOTP for a base32 secret — not needed when `DEV_AUTH_BYPASS=1`
(use `000000`).

## The three login surfaces (they are SEPARATE pages)

| Role                           | URL                  | Credentials (local)                                               |
| ------------------------------ | -------------------- | ----------------------------------------------------------------- |
| Org (manager / agent / viewer) | `/he/login`          | `manager@alpha.dev` (or `agent@` / `viewer@`) · `DevPassword123!` |
| Resident (Tenant)              | `/he/tenant/login`   | phone `0501234567` → **"send code"** → `000000`                   |
| Provider Admin                 | `/he/provider/login` | `provider@local.dev` · `DevPassword123!` · MFA `000000`           |

Notes:

- `000000` only works when `DEV_AUTH_BYPASS=1` **and** `NODE_ENV=development`
  (double-gated, prod-impossible — `apps/api/src/common/dev-auth-bypass.ts`,
  PR #219). It bypasses the **second factor only**: resident still needs an OTP
  _requested_ first (a row must exist); provider still needs the right password.
- The Provider tier shows an **Access-Reason gate** before any tab — that is
  intentional (D.37/D.55, audit trail). Enter a ticket ref like `INC-1001` **or**
  ≥20 substantive chars to pass it; the submit button stays disabled until valid.

## Seeding

- `pnpm --filter @emapp/db seed:dev` — baseline Alpha org (manager/agent/viewer,
  1 project, 3 owners) + a Beta org for cross-tenant smoke.
- `pnpm --filter @emapp/db seed:demo` — **rich** demo: 6 more projects across all
  6 statuses, ~36 apartments (mixed outreach status), ~40 owners + ownerships,
  documents, signature requests (mixed states), contractors + shares, tasks,
  notifications, project assignments. Idempotent (sentinel-guarded). Run it via
  the local override (see `seed-demo-local.ps1`) so it lands in the LOCAL db, not
  remote Neon.

Provider account: `pnpm --filter @emapp/db provider:bootstrap` creates one
(needs `BOOTSTRAP_ADMIN_EMAIL/PASSWORD/NAME` env). The local `provider@local.dev`
was bootstrapped this way; its password was reset to `DevPassword123!` for dev.

## Gotchas (learned the hard way)

- **Infisical overrides pre-set env vars** → always use the `-Inner` pattern to
  pin `DATABASE_URL` to local.
- **Provider login 401 with the right password** usually means the API is on
  remote Neon (where `provider@local.dev` doesn't exist) — restart via
  `start-dev-local.ps1`.
- **"Every load fails" / login 502** was a proxy bug (forwarding the `Expect`
  header to undici) — fixed in PR #227. If you see it again, check the proxy
  strips hop-by-hop request headers.
- New git **worktree** needs its own `pnpm install` + `cp .infisical.json`.
- Kill stray node processes between restarts: `Get-Process node | Stop-Process -Force`.
