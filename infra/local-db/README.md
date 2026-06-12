# Local dev Postgres (opt-in perf fix)

**Why:** the dev Neon DB lives in us-east-1 → ~165ms per query from Israel →
1.2-1.5s per authenticated request and 30-60s test files (V12 perf diagnosis,
ledger 2026-06-12). A local PG brings that to <1ms/query.

**One-time setup** (requires Docker Desktop):

```bash
docker compose -f docker-compose.dev.yml up -d      # starts PG16+ICU on :5433
pnpm db:local:migrate                                # applies all migrations
```

**Switching the api/web to local:** override DATABASE_URL for the session
(do NOT change Infisical dev — Neon stays the team default):

```bash
DATABASE_URL=postgresql://emapp:emapp_local_dev@localhost:5433/emapp \
  infisical run --env=dev -- pnpm --filter @emapp/api dev
```

Tests: same override before `vitest run`.

**Notes:** `db:local:migrate` routes through `infisical run --env=dev` so the
mandatory PII keys reach the migrate runner; ONLY `DATABASE_URL` is overridden.
NOTE: Infisical may inject its own DATABASE_URL — the wrapper's env override is
applied by Node AFTER infisical's injection? NO — infisical injects into the
child it spawns, so the wrapper sets DATABASE_URL on infisical's env and pnpm
inherits it; if infisical's dev env ALSO defines DATABASE_URL it will OVERRIDE
ours — in that case run with `infisical run --env=dev --` manually and export
DATABASE_URL inside, or verify with `pnpm db:local:migrate` and check the target
host in the migrate output. (To be settled in the runtime verification below.)
Fresh DB = no seed data; run signup/QA flows to populate. `docker compose down -v`
resets. The status checks/CI are untouched.

**Verification status (2026-06-12):** authored + statically validated; RUNTIME
verification (migrate+boot+spec timing) pending Docker Desktop on the dev
machine — not installed at authoring time (honest ledger note).
