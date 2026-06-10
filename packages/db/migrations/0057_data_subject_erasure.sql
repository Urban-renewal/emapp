-- ════════════════ 0057 · Data-subject ERASURE (right-to-be-forgotten) ═══════
-- Roadmap P0.C1 — owner-approved compliance code. Gate-6 (migration + PII).
--
-- Israeli Privacy Protection Law gives a data subject the right to have their
-- personal data erased. EMAPP today only soft-deletes (archived_at), which does
-- NOT destroy the PII — it stays pgcrypto-encrypted but recoverable. This
-- migration adds the storage substrate for a DEFENSIBLE, REPEATABLE erasure:
--
--   1. `owners.erased_at` / `owners.erased_by` — the tombstone marker. A
--      non-null `erased_at` means this owner's PII has been crypto-shredded;
--      the row is excluded from normal lists and is un-revealable.
--   2. `erasure_log` — an append-only compliance ledger: one row per erasure
--      recording WHO erased WHICH owner, WHEN, and WHICH field categories were
--      cleared. It NEVER stores the cleared PII values themselves (only the
--      field names) — the whole point is that the values are gone.
--
-- LEGAL-RETENTION CONFLICT (see docs/DECISION-erasure-vs-legal-retention.md):
-- an owner who signed a consent cannot have the signature EVENT destroyed (it
-- is legal proof for the urban-renewal project), but their identity PII must be
-- erasable. We resolve this with CRYPTO-SHRED / ANONYMIZE-IN-PLACE: the erase
-- path overwrites the encrypted PII columns (name, national_id, phone) with an
-- irreversible tombstone and NULLs the HMAC lookup hashes, while the
-- signatures / ownerships rows are RETAINED (identity redacted). No cascade
-- delete — project integrity survives.
--
-- Additive + idempotent + re-runnable (D.39 posture). Hand-authored
-- (drizzle-kit is unusable here — see packages/db/CLAUDE.md); a
-- meta/_journal.json entry (idx 57) is added in the same commit. NOT applied to
-- shared dev — Gate-6 PR is HELD for owner sign-off.

-- ─── owners: erasure tombstone columns ──────────────────────────────────────
-- Both nullable; a non-null `erased_at` is the "this owner was erased" flag.
-- `erased_by` references the actor (users.id); SET NULL on user delete so the
-- erasure tombstone survives even if the acting user is later removed (the
-- erasure_log row carries the durable forensic copy of the actor id).
ALTER TABLE owners ADD COLUMN IF NOT EXISTS erased_at timestamptz;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS erased_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Crypto-shred requires the HMAC lookup hashes to be NULL-able: an erased
-- owner has NO national_id / name to hash anymore, so the lookup hashes are
-- set to NULL (the value is gone, so it can no longer be found by HMAC).
-- name_hash + national_id_hash were NOT NULL (every live owner has them);
-- relax to NULL so the erase UPDATE can clear them. The unique index on
-- national_id_hash is already partial (WHERE archived_at IS NULL) and the
-- erase path also archives, so a NULL hash never collides there. phone_hash
-- is already nullable.
ALTER TABLE owners ALTER COLUMN name_hash DROP NOT NULL;
ALTER TABLE owners ALTER COLUMN national_id_hash DROP NOT NULL;

-- Partial index: the normal owner-list/scope queries filter `erased_at IS NULL`
-- (an erased owner drops out of every operational surface, same shape as the
-- archived_at partials). Cheap, supports the common path.
CREATE INDEX IF NOT EXISTS idx_owners_org_not_erased
  ON owners (org_id)
  WHERE erased_at IS NULL;

-- ─── erasure_log: append-only compliance ledger ─────────────────────────────
-- ORG-scoped (org_id) so it lives under the same tenant_isolation RLS posture
-- as owners. One row per executed erasure. `cleared_fields` is a jsonb array of
-- FIELD-CATEGORY NAMES (e.g. ["name","national_id","phone","name_hash",...]) —
-- never the values. `signatures_retained` / `ownerships_retained` record the
-- counts kept for legal validity (the anonymize-not-delete proof).
CREATE TABLE IF NOT EXISTS erasure_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  -- Actor: SET NULL on user delete so the ledger row outlives the acting user.
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email text,
  -- jsonb array of cleared field-category names. NEVER the cleartext values.
  cleared_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  signatures_retained integer NOT NULL DEFAULT 0,
  ownerships_retained integer NOT NULL DEFAULT 0,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erasure_log_org_time
  ON erasure_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erasure_log_owner
  ON erasure_log (owner_id);

-- ─── RLS: org-scoped, FORCE (mirrors owners / audit_log 0004) ───────────────
ALTER TABLE erasure_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_log FORCE ROW LEVEL SECURITY;

-- Guarded CREATE POLICY (idempotent) — CREATE POLICY has no IF NOT EXISTS, so a
-- manual re-apply / partial-failure replay would otherwise error (repo
-- convention since 0021 / 0050).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'erasure_log'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON erasure_log
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ─── app_user grants ────────────────────────────────────────────────────────
-- 0009 set ALTER DEFAULT PRIVILEGES so future tables auto-grant
-- SELECT/INSERT/UPDATE/DELETE to app_user. erasure_log is an APPEND-ONLY
-- compliance ledger: app_user (the in-withTenant role) gets INSERT + SELECT
-- only. No UPDATE/DELETE — a ledger row, once written, is immutable evidence.
REVOKE ALL ON TABLE erasure_log FROM app_user;
GRANT INSERT, SELECT ON TABLE erasure_log TO app_user;
