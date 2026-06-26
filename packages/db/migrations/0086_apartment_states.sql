-- 0086: apartment_states — Slice 2.7 (Wave 2.7, apartment legal/life future-states).
--
-- The structural MIRROR of 0084_owner_states, adapted to APARTMENTS. A new ADDITIVE
-- state dimension layered ALONGSIDE the locked apartment identity (apartments) — it
-- does NOT touch `apartments` or the Gate-2-locked `apartment_status` enum (D.18 is
-- LAW). An apartment may carry one or more legal/life conditions that change how the
-- org must treat it in the signature-collection process:
--   deceased        — a registered owner of the apartment is deceased; the rights
--                     pass to an estate / heirs before a binding signature.
--   dispute         — an ownership / boundary dispute (סכסוך) is open over the unit.
--   poa             — the unit is acted on under a power of attorney (ייפוי כוח).
--   eviction        — an eviction / tenancy-removal (פינוי) is in flight.
--   repairs         — outstanding structural repairs / defects (ליקויים) block use.
--   rights_transfer — a transfer of rights in the unit (העברת זכויות) is in flight.
--
-- ── NO PII (the load-bearing rule of THIS slice) ────────────────────────────
-- Unlike owner_states (which carries encrypted guardian PII), apartment_states
-- carries NO national_id / phone / contact / person identity. A state that
-- conceptually references a person (deceased / poa) captures it ONLY as the `kind`
-- / `sub_kind` enum + a bounded non-PII `note` label. There is intentionally NO
-- encrypted column and NO contact column — a contact-bearing extension is a
-- SEPARATE future slice. The person, when one is involved, is an `owner` /
-- `owner_state` (2.5), not a column here.
--
-- This migration:
--   1. CREATE TYPE apartment_state_kind + apartment_state_status (guarded —
--      idempotent under a concurrent test-worker migrate()). Belt-and-suspenders to
--      the Zod-at-edge closed enum (CreateApartmentStateSchema).
--   2. CREATE TABLE apartment_states (org_id-scoped; FK apartment_id CASCADE;
--      bounded non-PII `note`; status active/resolved; archived_at soft-delete).
--   3. Partial index on (org_id, kind) WHERE status='active' AND archived_at IS NULL
--      (the situation-picture count + recommender working set), plus a per-apartment
--      active index for the dossier badge read.
--   4. RLS — direct org_id policy (documents/external_share style), ENABLE + FORCE.
--   5. GRANTs to app_user (SELECT/INSERT/UPDATE; no DELETE — resolve/archive are
--      status/archived_at transitions, never a hard delete). Mirrors 0079/0084.
--
-- Reversibility: HIGH. DROP TABLE apartment_states; DROP TYPE apartment_state_status;
-- DROP TYPE apartment_state_kind restores the prior state. Guarded/idempotent so a
-- concurrent test-worker migrate() is safe.
--
-- RENUMBER-ON-MERGE NOTE: several unmerged PRs hold lower 008x numbers — #588/#591/
-- #592 (0083), #599 (0084), #598 (0087). This migration is `0086` with a `when`
-- (1784100000000) strictly greater than 0082's (1783800000000). If a conflicting
-- 0086 lands first, renumber THIS one to the next free index + bump its `when` above
-- the new max before merge.

-- ════════════════════ enum types (guarded) ══════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'apartment_state_kind') THEN
    CREATE TYPE apartment_state_kind AS ENUM (
      'deceased',
      'dispute',
      'poa',
      'eviction',
      'repairs',
      'rights_transfer'
    );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'apartment_state_status') THEN
    CREATE TYPE apartment_state_status AS ENUM ('active', 'resolved');
  END IF;
END;
$$;

-- ════════════════════ apartment_states ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS apartment_states (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Direct org_id isolation key (documents-style). RLS gates reads/writes by the
  -- app.organization_id GUC below. apartments themselves are reached via building →
  -- project (not org-scoped) — owner_states-style direct org_id makes the state RLS
  -- cheap + self-contained.
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- The apartment this legal/life state attaches to. CASCADE: when the apartment is
  -- hard-deleted its states go with it — they are facts ABOUT the apartment with no
  -- independent meaning. (Operational soft-delete is archived_at.)
  apartment_id       uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,

  -- The KIND of state (closed enum; Zod-at-edge + this type are belt-and-suspenders).
  kind               apartment_state_kind NOT NULL,

  -- Optional non-PII refinement label (a sub-type / short court reference). The
  -- create DTO bounds its length so it stays a label, not a PII payload.
  sub_kind           text,

  -- Optional bounded NON-PII note (a short free-text description of the matter —
  -- e.g. "פינוי דייר מוגן", a court reference). The create DTO bounds its length;
  -- the caller MUST NOT place PII here. There is NO encrypted/contact column — a
  -- person involved is an owner / owner_state, never stored here.
  note               text,

  -- Lifecycle: active while it bears on the process; resolved when the matter closes.
  status             apartment_state_status NOT NULL DEFAULT 'active',
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL,

  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Standard soft-delete (NOT deletedAt — archivedAt convention).
  archived_at        timestamptz,

  -- A resolved state carries a resolved_at; an active one does not. Keeps the
  -- lifecycle honest (no "active with resolved_at" / "resolved with no timestamp").
  CONSTRAINT apartment_states_resolved_consistency CHECK (
    (status = 'resolved' AND resolved_at IS NOT NULL)
    OR (status = 'active' AND resolved_at IS NULL)
  )
);

-- The situation-picture count + the recommender working set both scope to ACTIVE,
-- non-archived states per org. Partial index keeps those reads cheap at scale.
CREATE INDEX IF NOT EXISTS idx_apartment_states_org_active
  ON apartment_states (org_id, kind)
  WHERE status = 'active' AND archived_at IS NULL;

-- Apartment-dossier badge read: the active states for one apartment.
CREATE INDEX IF NOT EXISTS idx_apartment_states_apartment_active
  ON apartment_states (apartment_id)
  WHERE status = 'active' AND archived_at IS NULL;

-- ─── RLS (direct org_id — COPIED from external_share 0079 / owner_states 0084) ─
ALTER TABLE apartment_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE apartment_states FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'apartment_states'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON apartment_states
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; resolve/archive are status transitions) ──
GRANT SELECT, INSERT, UPDATE ON apartment_states TO app_user;
REVOKE DELETE ON apartment_states FROM app_user;
