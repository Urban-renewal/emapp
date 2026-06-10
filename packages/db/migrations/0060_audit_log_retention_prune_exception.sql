-- ============================================================================
-- 0060 — audit_log retention-prune carve-out (Gate-6, ISO 27001 A.12.4)
-- ============================================================================
-- Roadmap P0.C3. The append-only `trg_audit_log_immutable` trigger (migration
-- 0003) RAISES on EVERY audit_log UPDATE and DELETE — for every role, including
-- the BYPASSRLS maintenance pool (BYPASSRLS skips RLS POLICIES, not TRIGGERS).
-- That blanket block prevents the compliance RETENTION PRUNE from ever removing
-- aged-out rows, leaving the table to grow without bound.
--
-- This migration replaces ONLY the trigger FUNCTION body (the trigger
-- definition and its name are untouched) with a TIGHT, age-gated carve-out:
--
--   1. UPDATE            → ALWAYS RAISE. Audit rows must NEVER change. No
--                          exception, no predicate, no role check.
--   2. DELETE of a RECENT row (created_at >= now() - interval '24 months')
--                          → RAISE. This is the DB-LEVEL HARD FLOOR: recent
--                          forensic evidence is immutable and cannot be
--                          destroyed by anyone, independent of any app config.
--   3. DELETE of an OLD row (created_at < now() - interval '24 months')
--                          → RETURN OLD (permit). This is the ONLY mutation
--                          the trigger allows, and only past the floor — it is
--                          what lets the batched retention prune drain the
--                          aged-out backlog.
--
-- Defense in depth: the 24-month floor is enforced TWICE and independently —
-- here at the DB (this trigger) AND in the app (resolveRetentionMonths clamps
-- AUDIT_RETENTION_MONTHS up to ≥24). Even if the app clamp were removed or
-- misconfigured, the DB refuses to delete a row younger than 24 months. The
-- app default keeps 36 months, so in normal operation the prune only ever
-- presents rows well past this DB floor; the floor is the last-line guarantee,
-- not the working window.
--
-- The blocked branches keep the EXACT original message ('audit_log rows are
-- immutable') so existing callers / tests / the worker's
-- isAuditLogImmutableError recogniser continue to match unchanged.
--
-- STATEMENT-LEVEL TRUNCATE GUARD (additive — closes the owner/BYPASSRLS hole):
-- the row-level carve-out above is a BEFORE UPDATE OR DELETE trigger and so is
-- NEVER consulted for a TRUNCATE — TRUNCATE removes every row WITHOUT firing
-- row-level triggers. The BYPASSRLS owner role (neondb_owner / the provider
-- pool) retains TRUNCATE privilege and could therefore wipe the ENTIRE audit
-- trail (including <24-month evidence) in one statement, bypassing the
-- age-gated carve-out entirely. TRUNCATE is NEVER legitimate for audit_log —
-- the retention prune uses batched row-level DELETE only — so we add a
-- BEFORE TRUNCATE STATEMENT-LEVEL trigger that ALWAYS raises. A BEFORE TRUNCATE
-- trigger fires even for the table owner, so this closes the bypass. (TRUNCATE
-- supports only statement-level triggers, hence FOR EACH STATEMENT.)
--
-- Hand-authored. NOT applied to shared dev manually — it lands via the standard
-- migrate() path (test DB via global-setup; envs via pnpm db:migrate).
-- ============================================================================

CREATE OR REPLACE FUNCTION trigger_audit_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
  -- (1) UPDATE is unconditionally forbidden — audit rows never change.
  IF (TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'audit_log rows are immutable';
  END IF;

  -- (2) DELETE of a row inside the 24-month hard floor is forbidden. Recent
  --     evidence cannot be destroyed — this is the DB-level compliance floor,
  --     independent of the app-level AUDIT_RETENTION_MONTHS clamp.
  IF (TG_OP = 'DELETE' AND OLD.created_at >= now() - interval '24 months') THEN
    RAISE EXCEPTION 'audit_log rows are immutable';
  END IF;

  -- (3) DELETE of a row older than the 24-month floor is the ONLY permitted
  --     mutation — it lets the retention prune remove aged-out rows.
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Statement-level TRUNCATE guard (additive). ALWAYS raises — TRUNCATE is never
-- a legitimate operation on audit_log. Fires even for the BYPASSRLS table
-- owner, closing the statement-level append-only hole the row-level carve-out
-- above cannot cover.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_audit_log_no_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log cannot be truncated (append-only; ISO 27001 A.12.4)';
END;
$$ LANGUAGE plpgsql;

-- Idempotent / re-runnable: drop-if-exists then create.
DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit_log;
CREATE TRIGGER trg_audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION trigger_audit_log_no_truncate();
