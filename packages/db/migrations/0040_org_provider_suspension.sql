-- 0040 (D.49): Provider operational suspend/reactivate for organizations.
--
-- D.49 authorizes Provider Admin WRITE actions (superseding the D.37
-- read-only lock). The first write is suspend/reactivate a tenant — an
-- OPERATIONAL state, deliberately distinct from `archived_at` (soft
-- delete / "ארכוב"):
--   * archived_at  → the org was deleted from the customer's own view.
--   * suspended_at → the org is operationally frozen by the SaaS
--                    operator (billing, abuse, ToS). Reversible by a
--                    Provider Admin via the audit-first withProvider path.
--
-- `suspended_reason` is the operator-facing note shown in the console.
-- It is NOT the forensic `access_reason` (that lives in
-- provider_audit_log, written audit-first by withProvider). Reactivate
-- clears BOTH columns.
--
-- Both columns are nullable with no default — an unset org is "active",
-- so this migration is a no-op for every existing row (zero backfill,
-- zero lock beyond the catalog update).
--
-- Reversibility: pure DROP COLUMN. No existing query references these
-- columns; they are additive.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended_at     timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason text;
