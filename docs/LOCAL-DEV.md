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

## The IPv6 `localhost` tax (the #2 perf lever — browser feels slow)

If pages feel sluggish in the **browser** even though the API logs say each request
is ~40 ms, you are almost certainly paying the **IPv6 `localhost` tax** (diagnosed in
PR #581). It is a host/OS networking quirk, **not** an app defect.

**Mechanism.** Windows resolves `localhost` to **both** addresses and hands them out
**IPv6-first**:

```
localhost -> [ { address: '::1', family: 6 },        <- tried FIRST
              { address: '127.0.0.1', family: 4 } ]
```

So any client opening `http://localhost:3001` tries `[::1]` (IPv6 loopback) before
`127.0.0.1`. On this host the IPv6 loopback is **flaky** — a connect to `[::1]` can
stall ~200 ms (and a connect to an *unbound* `[::1]` port can hang 1–2 s instead of
returning a fast RST). Multiply that across a page's requests and every click is >1 s.

**The two independent levers (both in `start-dev-local.ps1`, no admin needed):**

1. `NODE_OPTIONS=--dns-result-order=ipv4first` — flips Node's resolver to IPv4-first.
   Fixes **server→server** hops only (SSR `getMe`, the `/api` proxy). Does **not** touch
   Chrome — Chrome has its own resolver.
2. `DEV_WEB_IPV4=1` — tells the web `dev` script (`apps/web/scripts/dev.mjs`) to launch
   `next dev --hostname 127.0.0.1`, i.e. **IPv4-only, no `[::1]` listener**. The browser's
   IPv6 attempt is then refused/abandoned instantly (Chrome's Happy-Eyeballs) and it uses
   `127.0.0.1`. This is the **browser** lever.

It is **opt-in** on purpose: binding IPv4-only is not free for a *serial* client (curl's
default, Node's `http.get`) that waits on the refused `[::1]` for 1–2 s. CI + Playwright
use exactly such serial `localhost` probes, so the shared `pnpm dev` / `turbo dev` default
stays dual-stack `0.0.0.0`; only the owner's local browser flow opts in.

**Measured warm `time_total` for `GET /` (this host, Next.js 15 dev, web only):**

| client / address                              | dual-stack `0.0.0.0` (default) | IPv4-only bound (`DEV_WEB_IPV4=1`) |
| --------------------------------------------- | ------------------------------ | ---------------------------------- |
| `127.0.0.1:3001` (direct)                     | ~8 ms                          | ~8 ms                              |
| **`localhost:3001` — Chrome (Happy-Eyeballs)**| ~8 ms *(when IPv6 healthy)* / **~200 ms when IPv6 degraded** | **~7 ms** ✅ |
| `localhost:3001` — curl/Node serial (CI)      | ~8 ms                          | ~215 ms ⚠️ (why the default stays dual-stack) |
| `[::1]:3001` direct                           | ~6 ms (accepts)                | refused, instant                   |

Net: with `DEV_WEB_IPV4=1`, **Chrome's `localhost` browsing no longer pays the IPv6 tax**
even when the host's IPv6 loopback is degraded.

### Definitive host-wide fix (OWNER-GATED — needs admin, do once)

The per-server bind above only helps Happy-Eyeballs clients. The **complete** fix is to
make `localhost` resolve straight to IPv4 for *every* client (Chrome, curl, Node) by adding
one line to the Windows hosts file — run **once** in an **Administrator** PowerShell:

```powershell
Add-Content -Path "$env:WINDIR\System32\drivers\etc\hosts" -Value "`r`n127.0.0.1`tlocalhost"
```

After that, `localhost` never offers `[::1]` at all, the tax is gone for everything, and you
can drop both `DEV_WEB_IPV4=1` and `--dns-result-order=ipv4first`. This is owner-gated only
because editing the hosts file needs admin — it is otherwise the cleanest fix.

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
  $env:NODE_OPTIONS = '--dns-result-order=ipv4first'  # Node server->server hops (see tax below)
  $env:DEV_WEB_IPV4 = '1'         # bind the WEB dev server IPv4-only for the browser (see tax below)
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
