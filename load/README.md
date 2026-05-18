# EMAPP — scale runbook & load harness

The API is for organizations at scale. Scale here is **managed by
measurement, not opinion** (see DECISIONS D.24). This is the operator
playbook.

## The model (why the bottleneck is connections, not CPU)

Every request runs ONE Postgres transaction under RLS:
`BEGIN; SET LOCAL ROLE app_user; set_config(GUCs); query; COMMIT`
(~4–5 round-trips). The API is **stateless** (JWT in an httpOnly cookie;
the 15s session-validity memo is a per-pod safety cache, not a
correctness dependency), so it scales horizontally. The shared chokepoint
is **Postgres connections**.

## Levers, in order of impact

1. **Neon transaction-mode pooler — #1, config-only (no code).**
   Point `DATABASE_URL` at the Neon **pooled** endpoint (`-pooler`,
   transaction mode). `withTenant`/`withProvider` are pooler-safe by
   construction: `SET LOCAL ROLE` + `set_config(..., true)` are
   transaction-scoped and reset at COMMIT — they never leak across
   pooled sessions. This multiplexes thousands of concurrent org users
   onto a few server connections.
2. **Pool sizing — now env-tunable (no code change):**
   `DB_POOL_MAX` (default 20), `DB_PROVIDER_POOL_MAX` (5),
   `DB_POOL_IDLE_MS` (30000), `DB_POOL_CONN_TIMEOUT_MS` (5000),
   `DB_STATEMENT_TIMEOUT_MS` (30000), `DB_PROVIDER_STATEMENT_TIMEOUT_MS`
   (60000). **Behind a transaction pooler set `DB_POOL_MAX` LOWER per
   pod** — the pooler multiplexes; `pods × max` must not exceed Postgres
   `max_connections`. Set via Infisical per environment.
3. **statement_timeout is already enforced** at the pool (30s app / 60s
   provider) so a runaway query cannot pin a connection — now tunable
   via the env above. (Earlier "no statement_timeout" note was wrong;
   corrected from the code.)
4. **Nested-read double query — load-bearing, do NOT delete.** Listing
   under a parent does an `assertXVisible` lookup THEN the page query.
   That first query is a PK point-lookup (sub-ms) and it is what makes a
   foreign/unknown parent return **404 (no-oracle)** instead of an empty
   200 — a security contract (proven by the cross-tenant matrix). The
   optimization is to MERGE both into ONE round-trip while preserving
   the 404, and only if k6 shows it matters (it won't until the pooler +
   sizing levers are exhausted). Measure before touching.
5. **Caching** — deliberately deferred (D.24). Add per-tenant, hot,
   low-churn reads WITH explicit invalidation only when k6/`pg_stat_
statements` justify it.

## How to manage it (the gate)

1. Run k6 against **staging** (never prod):
   `k6 run -e BASE=https://staging... load/k6-smoke.js`
2. While it ramps to 100 VUs, watch:
   - k6 `http_req_duration p95`, `http_req_failed` (thresholds fail the run)
   - Postgres: active/idle connections, `pg_stat_statements` top queries
   - Sentry performance traces (already wired)
3. Decision rule: if p95 degrades as VUs rise **while app CPU is low** →
   connection-bound → apply lever 1, lower `DB_POOL_MAX`, re-run.
4. Treat the k6 thresholds as a **release gate** before each prod deploy
   (Phase 9 / Gate 5) and after any data-path change.

## SLO (tune per product agreement)

- p95 latency < 1.5 s end-to-end (lower once on the pooler + co-located).
- error rate < 1 % under the 100-VU sustained stage.
- zero Postgres connection-exhaustion errors.
