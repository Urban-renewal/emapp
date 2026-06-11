-- 0066: discovery_records + retire ownerships 'renter' — S3c "renter → discovery-source".
--
-- Spec: docs/DESIGN-project-model-and-autosetup.md §2 (matrix-of-association)
-- + §6 (discovery layer). A "renter"/occupant is NOT an owner/signer — it is a
-- DISCOVERY SOURCE attached to an APARTMENT: a field worker spoke to whoever
-- lives there to learn who the owner is. Today `ownerships.relationship` ∈
-- ('owner','renter') OVERLOADS the ownership table with occupants. This
-- migration moves occupants to a dedicated apartment-attached table and RETIRES
-- 'renter' from ownerships so an occupant can NEVER be a signature recipient
-- (the recipient path resolves owner_id → owners/ownerships; a discovery record
-- has no owner_id and creates no ownership row).
--
-- This migration:
--   1. CREATE TABLE discovery_records (apartment-attached; closed status enum;
--      free-text notes; DEFERRED recording_ref/transcript slots — §6, never
--      populated this slice).
--   2. RLS — Template B (via parent), the SAME parent-chain isolation
--      building_sections uses (migration 0035): apartment_id → buildings →
--      projects → org_id GUC.
--   3. DATA-MIGRATE every existing relationship='renter' ownership row → a
--      discovery_records row (status 'spoke_to_occupant') on the SAME apartment,
--      then DELETE those renter ownership rows. Set-based.
--   4. RETIRE 'renter': drop the old relationship CHECK and re-add
--      CHECK (relationship IN ('owner')). The column stays (DEFAULT 'owner') for
--      compat, but no new renter ownership row can be inserted — this is what
--      establishes the global "no active renter ownership row" invariant.
--
-- Reversibility: MEDIUM. The discovery_records table + 'renter' retirement can
-- be reverted (DROP TABLE; restore the ('owner','renter') CHECK), but the
-- renter→discovery DATA move is one-way (the deleted renter ownership rows are
-- not reconstructable from discovery_records — created_by/started_at are lost by
-- design; an occupant was never a real ownership stake).

-- ════════════════════ discovery_records ═════════════════════════════
CREATE TABLE IF NOT EXISTS discovery_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Denormalised org_id is acceptable here (UNLIKE buildings/apartments per the
  -- 0011 revert) because discovery_records is a LEAF with its own org column on
  -- the row the app writes directly; RLS still isolates via the parent chain
  -- (apartment → building → project → org) below, so org_id can never be used to
  -- widen visibility — it is a convenience/index column, not the isolation key.
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- The apartment this discovery source is attached to. ON DELETE CASCADE: a
  -- discovery record is meaningless without its apartment.
  apartment_id  uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,

  -- Closed discovery-status enum (§6). DB CHECK (belt-and-suspenders alongside
  -- the Zod enum at the API edge) — this is a small, stable closed set.
  status        text NOT NULL DEFAULT 'not_visited'
                  CHECK (status IN ('not_visited','no_answer','spoke_to_occupant','owner_identified','refused')),

  -- Free-text field notes.
  notes         text,

  -- §6 DEFERRED slots — audio recording reference + transcript. Present in the
  -- schema (zero future migration debt) but NEVER populated this slice; the
  -- create/update DTOs deliberately omit them.
  recording_ref text,
  transcript    text,

  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_discovery_records_org
  ON discovery_records (org_id);

CREATE INDEX IF NOT EXISTS idx_discovery_records_apartment
  ON discovery_records (apartment_id)
  WHERE archived_at IS NULL;

-- ─── RLS (Template B — via parent; COPIED from building_sections 0035) ───────
ALTER TABLE discovery_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_records FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'discovery_records'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON discovery_records
      USING (
        apartment_id IN (
          SELECT a.id FROM apartments a
          WHERE a.building_id IN (
            SELECT b.id FROM buildings b
            WHERE b.project_id IN (
              SELECT p.id FROM projects p
              WHERE p.org_id = current_setting('app.organization_id', true)::uuid
            )
          )
        )
      )
      WITH CHECK (
        apartment_id IN (
          SELECT a.id FROM apartments a
          WHERE a.building_id IN (
            SELECT b.id FROM buildings b
            WHERE b.project_id IN (
              SELECT p.id FROM projects p
              WHERE p.org_id = current_setting('app.organization_id', true)::uuid
            )
          )
        )
      );
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; soft delete via archived_at) ────
GRANT SELECT, INSERT, UPDATE ON discovery_records TO app_user;
REVOKE DELETE ON discovery_records FROM app_user;

-- ════════════════════ data-migrate renter → discovery ═══════════════
-- Every existing relationship='renter' ownership row becomes a discovery record
-- (status 'spoke_to_occupant') on its apartment. org_id is resolved via the
-- apartment's project (apartment → building → project). Set-based INSERT…SELECT.
-- created_by NULL (the field worker who recorded the occupant is not captured on
-- the legacy ownership row), notes NULL.
INSERT INTO discovery_records (org_id, apartment_id, status, notes, created_by)
SELECT p.org_id, o.apartment_id, 'spoke_to_occupant', NULL, NULL
FROM ownerships o
JOIN apartments a ON a.id = o.apartment_id
JOIN buildings  b ON b.id = a.building_id
JOIN projects   p ON p.id = b.project_id
WHERE o.relationship = 'renter';

-- The data-migrate DELETE touches `ownerships`, which carries the DEFERRABLE
-- sum-check trigger (trg_ownerships_sum_check). Deleting a RENTER row is
-- provably safe for the owner-sum invariant — renters are EXCLUDED from that sum
-- (`... AND relationship = 'owner'`), so removing one never changes any
-- apartment's owner-sum. But the deferred trigger still QUEUES a re-check on
-- every apartment the DELETE touched, and would then re-validate the apartment's
-- (unrelated) owner rows at flush time — failing on any apartment that already
-- carries a legacy/broken owner set. We must not let an unrelated pre-existing
-- owner-set state abort this occupant-migration, so we DISABLE the sum trigger
-- for the duration of the DELETE and re-enable it immediately after. The owner
-- rows themselves are untouched, so the invariant they hold is unchanged.
ALTER TABLE ownerships DISABLE TRIGGER trg_ownerships_sum_check;

DELETE FROM ownerships WHERE relationship = 'renter';

ALTER TABLE ownerships ENABLE TRIGGER trg_ownerships_sum_check;

SET CONSTRAINTS ALL IMMEDIATE;

-- ════════════════════ retire 'renter' from ownerships ═══════════════
-- Drop the old ('owner','renter') CHECK (migration 0051) and re-add an
-- owner-only CHECK. The column stays NOT NULL DEFAULT 'owner' for compat; after
-- this, no INSERT can introduce a renter ownership row — the occupant concept
-- lives ONLY in discovery_records now. This is what makes the global no-renter
-- invariant hold going forward.
ALTER TABLE ownerships DROP CONSTRAINT IF EXISTS ownerships_relationship_check;

ALTER TABLE ownerships
  ADD CONSTRAINT ownerships_relationship_check
  CHECK (relationship IN ('owner'));
