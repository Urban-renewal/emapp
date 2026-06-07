-- Feature A (P2 / D.25 sum-trigger change, risk: HIGH) — owner/renter.
--
-- Spec: docs/decision-records/P2-feature-a-owner-renter.md.
-- Owner-authorized direction: relationship ∈ {owner,renter}; a renter
-- carries ownership_pct = 0, does NOT sign, and is EXCLUDED from the
-- D.25 100%-ownership sum. Every existing row backfills to 'owner'
-- (DEFAULT 'owner'), so the new predicate over existing data is
-- IDENTICAL to today's — no currently-valid apartment can newly violate.
--
-- This migration:
--   1. Adds `relationship text NOT NULL DEFAULT 'owner'` to `ownerships`
--      + a CHECK constraint pinning the closed set ('owner','renter').
--   2. CREATE OR REPLACE FUNCTION trigger_check_ownership_sum() — the
--      0030 body BYTE-FOR-BYTE, with EXACTLY TWO changes:
--        (a) the inner SUM's WHERE gains `AND relationship = 'owner'`
--            (renters excluded from the 100% invariant), and
--        (b) the function gains `SET search_path = pg_temp, public`
--            — closing the known §v8-M5 hardening gap (that item said
--            "the next ownership-trigger migration adds it"). pg_temp is
--            FIRST so the per-tx memo TEMP TABLE `_ownership_sum_checked`
--            still resolves to the session temp schema; `public` covers
--            the `ownerships` table reference.
--   The trigger BINDING (trg_ownerships_sum_check, FOR EACH ROW DEFERRABLE
--   INITIALLY DEFERRED) is UNCHANGED — CREATE OR REPLACE FUNCTION rebinds
--   the existing trigger; we do NOT drop/recreate it. The memo logic
--   (lazy TEMP TABLE + ON CONFLICT DO NOTHING short-circuit) is unchanged.

ALTER TABLE ownerships ADD COLUMN relationship text NOT NULL DEFAULT 'owner';

ALTER TABLE ownerships
  ADD CONSTRAINT ownerships_relationship_check
  CHECK (relationship IN ('owner', 'renter'));

CREATE OR REPLACE FUNCTION trigger_check_ownership_sum()
RETURNS TRIGGER
SET search_path = pg_temp, public
AS $$
DECLARE
  v_apartment_id uuid;
  v_total numeric(7,2);
  v_first_check boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_apartment_id := OLD.apartment_id;
  ELSE
    v_apartment_id := NEW.apartment_id;
  END IF;

  -- Lazy-create the per-tx memo table. CREATE IF NOT EXISTS is the
  -- right primitive here — it's idempotent across calls within the
  -- same tx and the table drops at COMMIT automatically.
  CREATE TEMP TABLE IF NOT EXISTS _ownership_sum_checked (
    apartment_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  -- ON CONFLICT DO NOTHING + RETURNING: the row is inserted iff
  -- this apartment wasn't already validated in this tx. The
  -- RETURNING clause yields no row when DO NOTHING fired, so
  -- v_first_check is FALSE in that case.
  v_first_check := FALSE;
  INSERT INTO _ownership_sum_checked (apartment_id)
  VALUES (v_apartment_id)
  ON CONFLICT DO NOTHING
  RETURNING TRUE INTO v_first_check;

  IF v_first_check IS NOT TRUE THEN
    -- Already validated for this apartment in this tx → short-circuit.
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(ownership_pct), 0) INTO v_total
  FROM ownerships
  WHERE apartment_id = v_apartment_id AND ended_at IS NULL AND relationship = 'owner';

  IF v_total > 0 AND v_total <> 100 THEN
    RAISE EXCEPTION 'Sum of ownership percentages must equal 100 for apartment %, got %',
      v_apartment_id, v_total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger DEFINITION is unchanged (still FOR EACH ROW DEFERRABLE
-- INITIALLY DEFERRED) — only the function got the relationship filter
-- + search_path hardening. We do NOT drop+recreate the trigger;
-- CREATE OR REPLACE FUNCTION rebinds.
