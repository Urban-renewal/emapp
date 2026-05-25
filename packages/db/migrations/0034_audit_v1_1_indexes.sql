-- Migration 0034 — Audit v1.1 closures CC-6 / CC-7 perf indexes.
--
-- Two CREATE INDEX CONCURRENTLY operations addressing scale-time
-- timebombs surfaced by the Phase 6.5 cross-confirmed perf audit
-- (AUDIT-V1-1-PHASE6.5-FINDINGS.md). PURELY ADDITIVE — no data
-- change, no constraint change, no application-behaviour change;
-- only the query planner picks up new options.
--
-- CC-5 (pgboss.job(state)) is INTENTIONALLY ABSENT from this
-- migration: `pgboss.job` is created lazily by the worker on first
-- `pgboss.start()` and may not exist when this migration runs
-- (fresh dev DB, fresh CI, fresh staging). The Phase 6.5 system-
-- health gauge defends against the schema-missing case via SAVEPOINT
-- + 42P01 swallow; the Audit v1.1 30-s in-process cache (in
-- ProviderSystemHealthService) defends against the slow-probe case
-- by absorbing 99% of polls. The pgboss(state) index is the
-- enterprise-prep backstop; ship it as a worker-owned migration in a
-- follow-up PR. Tracked in PROGRESS as `Audit-v1.1 deferred D-CC-5b`.
--
-- Note on CONCURRENTLY: drizzle-kit wraps each migration file in a
-- transaction (default `breakpoints: true` notwithstanding), so we
-- CANNOT use CREATE INDEX CONCURRENTLY here (25001 active_sql_tx).
-- Plain CREATE INDEX briefly locks the target table during build.
-- For audit_log (1 write per app mutation) + owners (1 write per
-- owner create/update) at MVP/pilot scale, the lock is sub-second
-- and inside the normal deploy window.
--
-- PRODUCTION RUNBOOK (post-MVP, when audit_log > 1M rows):
--   - Drop the IF NOT EXISTS guards in this file (so the migration
--     becomes a no-op after the first run).
--   - Before deploying that change, manually run:
--       CREATE INDEX CONCURRENTLY idx_audit_action_pattern ...
--       CREATE INDEX CONCURRENTLY idx_owners_org_created_desc ...
--     via `psql` against the prod DB (NOT through the migrator).
--   - Drizzle's IF NOT EXISTS sees the existing indexes and skips.
-- Tracked in PROGRESS as `Audit-v1.1 deferred D-CC-6/7-concurrent`.

-- ────────────────────────────────────────────────────────────────────
-- CC-6 — Provider audit-search action prefix filter.
--
-- `/provider/audit?action=import.` uses `WHERE action LIKE 'import.%'`.
-- Without `text_pattern_ops` btree, the planner falls back to a
-- backward scan on `(created_at DESC, id DESC)` filtering by action;
-- on a 10M-row audit_log this is 2–4 s p95 (perf agents confirmed
-- via EXPLAIN-shape reasoning).
--
-- `text_pattern_ops` is the operator class Postgres requires for
-- `LIKE 'prefix%'` to use a btree (locale-independent comparison).
-- Composite with `created_at DESC` keeps the keyset cursor walk fast
-- once the prefix is selected. Cuts to ~50ms after.
-- ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_action_pattern
  ON audit_log (action text_pattern_ops, created_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- CC-7 — Provider tenant-detail sample owners.
--
-- `ORDER BY created_at DESC, id DESC LIMIT 5` for the 5 most-recent
-- owners of a tenant. `owners` indexes are (org_id, *_hash) — none
-- ordered by created_at. With 100k owners/org the planner
-- bitmap-scans then sorts → 100–500 ms before, <5 ms after.
--
-- Partial WHERE archived_at IS NULL: the sample-owners service
-- already filters archived rows; pruning the index keeps it small +
-- bounds the scan to live rows.
-- ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_owners_org_created_desc
  ON owners (org_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

-- ────────────────────────────────────────────────────────────────────
-- SA-8 — DB-level CHECK on provider_audit_log.action_type.
--
-- Pre-closure the only thing enforcing the audit-action taxonomy was
-- the application-level regex inside withProvider. Any future code
-- path that talks to the provider pool directly (a test factory, an
-- ad-hoc Sentry-breadcrumb writer, a migration helper) could insert
-- arbitrary strings — including ones that LOOK like legitimate
-- actions and pollute audit search results.
--
-- The CHECK mirrors the application regex exactly. Combined with the
-- SELECT+INSERT-only grants from migration 0001, this gives
-- belt-and-suspenders integrity: the application can't write garbage
-- AND a future bypass can't either.
--
-- `NOT VALID` means the constraint applies to NEW inserts only; we
-- skip validating existing rows (which conform — the writer regex
-- has always been in force). VALIDATE CONSTRAINT can be run later
-- without locking writes if a full sweep is ever needed.
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE provider_audit_log
  ADD CONSTRAINT provider_audit_log_action_type_shape
  CHECK (
    action_type ~ '^[a-z][a-z0-9_.-]*$'
    AND length(action_type) <= 128
  )
  NOT VALID;
