-- v4 audit fix (P0 perf): memoize the ownership-sum check per
-- transaction so a bulk INSERT of N rows produces M (= unique
-- apartments) SUM queries instead of N.
--
-- Background: migration 0002 created `trg_ownerships_sum_check`
-- as a DEFERRABLE INITIALLY DEFERRED constraint trigger. At COMMIT
-- the trigger fires once PER ROW that was inserted/updated/deleted
-- in the transaction. For a 1000-row import that's 1000 calls to
-- the trigger function, and each call runs a full SUM query over
-- the apartment's ownership rows. Net effect: O(N) trigger fires
-- × O(N) SUM scan = O(N²) — the dominant cost in T6.11 (1000-row
-- import slipping to ~400s).
--
-- Why not FOR EACH STATEMENT: PostgreSQL CONSTRAINT TRIGGERs MUST
-- be FOR EACH ROW (it's a documented limitation — the deferred
-- semantics that we rely on for D.25 set-replace are only available
-- on per-row constraint triggers). Transition tables (REFERENCING
-- NEW TABLE / OLD TABLE) are likewise not supported on constraint
-- triggers.
--
-- Solution: memoize per transaction via a session-scoped temp table.
-- The first fire for a given apartment_id runs the SUM check + marks
-- the apartment as "checked"; subsequent fires for the same apartment
-- in the same transaction short-circuit. The temp table is created
-- on-demand and ON COMMIT DROP, so the memo is naturally
-- transaction-scoped. This collapses N fires × M apartments down to
-- N fires + M actual SUM queries — typically M=1 to M=10 for an
-- urban-renewal import (one building, a few apartments).
--
-- Correctness invariant unchanged: the trigger still runs at COMMIT
-- on every ownership row, still validates SUM(ownership_pct)=100 per
-- apartment, still allows the intermediate-inconsistent set-replace
-- pattern (D.25). The memo only short-circuits REDUNDANT checks for
-- the same apartment within the same tx.

CREATE OR REPLACE FUNCTION trigger_check_ownership_sum()
RETURNS TRIGGER AS $$
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
  WHERE apartment_id = v_apartment_id AND ended_at IS NULL;

  IF v_total > 0 AND v_total <> 100 THEN
    RAISE EXCEPTION 'Sum of ownership percentages must equal 100 for apartment %, got %',
      v_apartment_id, v_total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger DEFINITION is unchanged (still FOR EACH ROW DEFERRABLE
-- INITIALLY DEFERRED) — only the function got smarter. We do NOT
-- drop+recreate the trigger; CREATE OR REPLACE FUNCTION rebinds.
