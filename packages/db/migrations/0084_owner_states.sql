-- 0084: owner_states — Slice 2.5 (Wave 2.5, owner legal/life future-states).
--
-- A new ADDITIVE state dimension layered ALONGSIDE the locked owner identity
-- (owners) — it does NOT touch `owners` or any locked enum. An owner may carry
-- one or more legal/life conditions that change how the org must treat them in
-- the signature-collection process:
--   competency  — the owner lacks legal capacity; a GUARDIAN (אפוטרופוס) acts for
--                 them. THIS kind carries guardian PII (encrypted below).
--   dispute     — an ownership dispute (סכסוך בעלות) is open (consent contested).
--   transfer    — an ownership transfer (העברת זכויות) is in flight.
--   lien        — a lien / attachment (עיקול / שעבוד) encumbers the rights.
--   verify      — identity / standing needs verification before the signature.
--   consent_withdrawal — the owner withdrew processing-consent (standing fact).
--
-- ── GUARDIAN PII (the load-bearing rule of this slice) ──────────────────────
-- Guardian name / phone / national_id are PII. They are stored pgcrypto-encrypted
-- at rest as `guardian_*_encrypted bytea`, MIRRORING `owners.national_id_encrypted`
-- (encrypt/decrypt via the SAME encryptField/decryptField + key PII_ENCRYPTION_KEY).
-- The wire view returns a MASKED guardian label only; cleartext NEVER crosses the
-- wire, is NEVER logged, and is NEVER placed in proposal evidence / audit afterState.
-- There is intentionally NO guardian *_hash column (no exact-match lookup need) and
-- NO reveal endpoint in this slice — the guardian identity is write-then-masked.
--
-- This migration:
--   1. CREATE TYPE owner_state_kind + owner_state_status (guarded — idempotent
--      under a concurrent test-worker migrate()). Belt-and-suspenders to the
--      Zod-at-edge closed enum (CreateOwnerStateSchema).
--   2. CREATE TABLE owner_states (org_id-scoped; FK owner_id CASCADE; guardian
--      *_encrypted bytea; status active/resolved; archived_at soft-delete).
--   3. Partial index on (org_id) WHERE status='active' AND archived_at IS NULL
--      (the situation-picture count + recommender working set).
--   4. RLS — direct org_id policy (documents/external_share style), ENABLE + FORCE.
--   5. GRANTs to app_user (SELECT/INSERT/UPDATE; no DELETE — resolve/archive are
--      status/archived_at transitions, never a hard delete). Mirrors 0079.
--
-- Reversibility: HIGH. DROP TABLE owner_states; DROP TYPE owner_state_status;
-- DROP TYPE owner_state_kind restores the prior state. Guarded/idempotent so a
-- concurrent test-worker migrate() is safe.
--
-- RENUMBER-ON-MERGE NOTE: the unmerged PRs #588/#591/#592 also hold a `0083`
-- (Wave 2.4 / 4.1). This migration is `0084` with a `when` strictly greater than
-- 0082's (1783800000000). If a real 0083 lands first this stays 0084; if a
-- conflicting 0084 lands, renumber THIS one to the next free index + bump its
-- `when` above the new max before merge.

-- ════════════════════ enum types (guarded) ══════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'owner_state_kind') THEN
    CREATE TYPE owner_state_kind AS ENUM (
      'competency',
      'dispute',
      'transfer',
      'lien',
      'verify',
      'consent_withdrawal'
    );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'owner_state_status') THEN
    CREATE TYPE owner_state_status AS ENUM ('active', 'resolved');
  END IF;
END;
$$;

-- ════════════════════ owner_states ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS owner_states (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Direct org_id isolation key (documents-style). RLS gates reads/writes by the
  -- app.organization_id GUC below.
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- The owner this legal/life state attaches to. CASCADE: when the owner is hard-
  -- deleted (a rare ops/erasure path) its states go with it — they are facts ABOUT
  -- the owner with no independent meaning. (Operational soft-delete is archived_at.)
  owner_id           uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,

  -- The KIND of state (closed enum; Zod-at-edge + this type are belt-and-suspenders).
  kind               owner_state_kind NOT NULL,

  -- Optional non-PII refinement label (a sub-type / short court reference). The
  -- create DTO bounds its length so it stays a label, not a PII payload.
  sub_kind           text,

  -- ── Guardian PII — pgcrypto-encrypted at rest (mirror owners.national_id_encrypted).
  -- Only meaningful for `competency`; NULL otherwise. NEVER returned cleartext, NEVER
  -- logged. No *_hash column (no exact-match lookup need); no reveal endpoint.
  guardian_name_encrypted        bytea,
  guardian_phone_encrypted       bytea,
  guardian_national_id_encrypted bytea,

  -- Lifecycle: active while it bears on the process; resolved when the matter closes.
  status             owner_state_status NOT NULL DEFAULT 'active',
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL,

  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Standard soft-delete (NOT deletedAt — D.x archivedAt convention).
  archived_at        timestamptz,

  -- A resolved state carries a resolved_at; an active one does not. Keeps the
  -- lifecycle honest (no "active with resolved_at" / "resolved with no timestamp").
  CONSTRAINT owner_states_resolved_consistency CHECK (
    (status = 'resolved' AND resolved_at IS NOT NULL)
    OR (status = 'active' AND resolved_at IS NULL)
  )
);

-- The situation-picture count + the recommender working set both scope to ACTIVE,
-- non-archived states per org. Partial index keeps those reads cheap at scale.
CREATE INDEX IF NOT EXISTS idx_owner_states_org_active
  ON owner_states (org_id, kind)
  WHERE status = 'active' AND archived_at IS NULL;

-- Owner-detail badge read: the active states for one owner.
CREATE INDEX IF NOT EXISTS idx_owner_states_owner_active
  ON owner_states (owner_id)
  WHERE status = 'active' AND archived_at IS NULL;

-- ─── RLS (direct org_id — COPIED from external_share, migration 0079) ────────
ALTER TABLE owner_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_states FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'owner_states'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON owner_states
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; resolve/archive are status transitions) ──
GRANT SELECT, INSERT, UPDATE ON owner_states TO app_user;
REVOKE DELETE ON owner_states FROM app_user;
