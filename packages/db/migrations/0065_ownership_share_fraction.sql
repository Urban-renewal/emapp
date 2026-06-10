-- S3b — ownership share AS FRACTION (exact Tabu fractions, sum = 1).
--
-- Spec: ownership shares are EXACT rational fractions (e.g. 1/3, 17/240),
-- not just a 2-decimal percent. The legacy model stored only
-- `ownership_pct numeric(5,2)` and the D.25 sum trigger required
-- SUM(ownership_pct) FILTER (relationship='owner', ended_at IS NULL) = 100.
-- A faithful 1/3 + 1/3 + 1/3 split is impossible there: 33.33 × 3 = 99.99
-- ≠ 100 → the trigger rejects the COMMIT.
--
-- This migration:
--   1. Adds integer `share_numerator` / `share_denominator` columns,
--      backfills them from the existing ownership_pct (pct → num/10000),
--      makes them NOT NULL with sane DEFAULTs, and pins denominator > 0.
--   2. Rewrites trigger_check_ownership_sum() so the SOLE per-apartment sum
--      invariant is the EXACT FRACTION sum = 1 over relationship='owner' rows,
--      via INTEGER cross-multiplication (no float). The legacy
--      SUM(ownership_pct)=100 check is REMOVED: it is now both redundant (the
--      fraction is the source of truth; pct is a derived 2-decimal display)
--      AND harmful — an exact thirds split derives ownership_pct =
--      round(1/3*100,2) = 33.33, and 33.33×3 = 99.99 ≠ 100, so the legacy
--      check would REJECT a faithful split whose fractions sum to exactly 1.
--      The per-tx memo (0030) + relationship='owner' filter (0051) +
--      empty-apartment skip + search_path hardening (0051) are all preserved.
--
-- Invariant after this migration: ownership_pct is a DERIVED display value
-- (round(num/den*100, 2)); the canonical share is the fraction num/den and the
-- ONLY sum check is fraction sum = 1. pct = 100 is NO LONGER enforced.
--
-- Back-compat: the new columns carry DEFAULTs (0 / 10000) so a pct-only
-- INSERT that does not name them still succeeds — a legacy caller passing
-- pct that summed to 100 backfilled num=round(pct*100), den=10000, which sum
-- to fraction 1, so it passes the fraction check. All write paths (service +
-- worker import) treat num/den as canonical and derive pct = round(num/den*100,2).
--
-- Existing data: rows backfilled num = round(pct*100), den = 10000 (see 1b).
-- Because the OLD invariant guaranteed SUM(ownership_pct)=100 per apartment,
-- SUM(num/10000) = SUM(pct*100)/10000 = 100*100/10000 = 1 — so every existing
-- apartment still passes the new fraction-only check unchanged.

-- 1a. Add the fraction columns (nullable first, so we can backfill).
ALTER TABLE ownerships ADD COLUMN share_numerator bigint;
ALTER TABLE ownerships ADD COLUMN share_denominator bigint;

-- 1b. Backfill every existing row from ownership_pct. pct 33.33 → 3333/10000,
--     pct 50 → 5000/10000, renter pct 0 → 0/10000. round() keeps it exact to
--     the 2 decimals ownership_pct already held.
UPDATE ownerships
SET share_numerator = round(ownership_pct * 100)::bigint,
    share_denominator = 10000
WHERE share_numerator IS NULL OR share_denominator IS NULL;

-- The backfill UPDATE above touches `ownerships`, which has the DEFERRABLE
-- INITIALLY DEFERRED constraint trigger `trg_ownerships_sum_check`. Inside the
-- migrator's single transaction those trigger events are queued and would
-- still be PENDING when we ALTER the table below — Postgres then refuses with
-- 55006 "cannot ALTER TABLE … because it has pending trigger events". Flush
-- them now: the existing rows already satisfy the (unchanged) pct invariant,
-- so firing the check here is a no-op and clears the queue before the ALTERs.
SET CONSTRAINTS ALL IMMEDIATE;

-- 1c. Lock them down: NOT NULL + a positive-denominator CHECK. DEFAULTs let
--     a pct-only INSERT (e.g. the legacy doc-test path) omit them; every real
--     write path derives them from pct.
ALTER TABLE ownerships ALTER COLUMN share_numerator SET DEFAULT 0;
ALTER TABLE ownerships ALTER COLUMN share_denominator SET DEFAULT 10000;
ALTER TABLE ownerships ALTER COLUMN share_numerator SET NOT NULL;
ALTER TABLE ownerships ALTER COLUMN share_denominator SET NOT NULL;

ALTER TABLE ownerships
  ADD CONSTRAINT ownerships_share_den_positive CHECK (share_denominator > 0);

-- 2. Rewrite the sum trigger. The SOLE invariant at COMMIT over the
--    apartment's active owner rows (relationship='owner', ended_at NULL) is:
--      FRACTION: SUM(share_numerator / share_denominator) is exactly 0 OR
--      exactly 1, computed in INTEGER arithmetic (no float). We take L =
--      LCM of the distinct owner denominators and require
--      SUM(share_numerator * (L / share_denominator)) = L.
--
--    The legacy SUM(ownership_pct)=100 check is GONE: ownership_pct is now a
--    derived display value and the fraction is canonical, so a faithful thirds
--    split (1/3 each → derived pct 33.33, summing to 99.99) must be ACCEPTED.
--    Enforcing pct=100 here would wrongly reject it.
--
--    LCM / overflow: Tabu denominators are small (3, 4, 240, …) so L stays far
--    inside bigint. We still GUARD overflow: the LCM loop caps L at a safe
--    bound (1e15); if it would exceed that, we FALL BACK to a numeric-equality
--    check (SUM(num::numeric / den) = 1 at scale 12) rather than risk an
--    integer overflow. The integer path is the primary, exact path.
CREATE OR REPLACE FUNCTION trigger_check_ownership_sum()
RETURNS TRIGGER
SET search_path = pg_temp, public
AS $$
DECLARE
  v_apartment_id uuid;
  v_first_check boolean;
  v_owner_rows int;
  v_lcm bigint;
  v_den bigint;
  v_g bigint;
  v_a bigint;
  v_b bigint;
  v_overflow boolean := false;
  v_frac_sum bigint;
  v_num_sum numeric;
  -- Cap for the running LCM before we declare overflow risk and fall back
  -- to the numeric path. 1e15 is comfortably inside bigint (max ~9.2e18) and
  -- leaves headroom for the SUM(num * (L/den)) accumulation.
  c_lcm_cap CONSTANT bigint := 1000000000000000;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_apartment_id := OLD.apartment_id;
  ELSE
    v_apartment_id := NEW.apartment_id;
  END IF;

  -- Per-tx memo (migration 0030): validate each apartment at most once per
  -- transaction. Lazy TEMP TABLE, ON COMMIT DROP → naturally tx-scoped.
  CREATE TEMP TABLE IF NOT EXISTS _ownership_sum_checked (
    apartment_id uuid PRIMARY KEY
  ) ON COMMIT DROP;

  v_first_check := FALSE;
  INSERT INTO _ownership_sum_checked (apartment_id)
  VALUES (v_apartment_id)
  ON CONFLICT DO NOTHING
  RETURNING TRUE INTO v_first_check;

  IF v_first_check IS NOT TRUE THEN
    -- Already validated for this apartment in this tx → short-circuit.
    RETURN NULL;
  END IF;

  -- How many active OWNER rows does the apartment have? Zero owners = an
  -- empty / cleared apartment, which is always valid (an apartment with no
  -- owner shares is fine — nothing to sum).
  SELECT count(*) INTO v_owner_rows
  FROM ownerships
  WHERE apartment_id = v_apartment_id AND ended_at IS NULL AND relationship = 'owner';

  IF v_owner_rows = 0 THEN
    RETURN NULL;
  END IF;

  -- FRACTION invariant — exact, integer cross-multiplication. This is the
  -- SOLE per-apartment sum check (the legacy SUM(ownership_pct)=100 check was
  -- removed: pct is now a derived display value, fraction is canonical).
  -- Compute L = LCM of the distinct owner denominators, guarding overflow.
  v_lcm := 1;
  FOR v_den IN
    SELECT DISTINCT share_denominator
    FROM ownerships
    WHERE apartment_id = v_apartment_id AND ended_at IS NULL AND relationship = 'owner'
  LOOP
    -- lcm(a,b) = a / gcd(a,b) * b. Compute gcd by Euclid.
    v_a := v_lcm;
    v_b := v_den;
    WHILE v_b <> 0 LOOP
      v_g := v_a % v_b;
      v_a := v_b;
      v_b := v_g;
    END LOOP;
    -- v_a is gcd(v_lcm, v_den); guard the multiply against the cap.
    IF (v_lcm / v_a) > (c_lcm_cap / v_den) THEN
      v_overflow := true;
      EXIT;
    END IF;
    v_lcm := (v_lcm / v_a) * v_den;
  END LOOP;

  IF NOT v_overflow THEN
    -- Exact integer sum: Σ num_i * (L / den_i). Equals L ⇔ the fraction
    -- sum is exactly 1. (Denominators divide L exactly by construction.)
    SELECT COALESCE(SUM(share_numerator * (v_lcm / share_denominator)), 0)
    INTO v_frac_sum
    FROM ownerships
    WHERE apartment_id = v_apartment_id AND ended_at IS NULL AND relationship = 'owner';

    -- FIX 2 (data-integrity): the apartment HAS active owner rows here
    -- (v_owner_rows > 0 — the empty/cleared case already RETURNed above), so
    -- the owner shares MUST sum to exactly the whole. A non-empty owner set
    -- summing to 0 (every owner at 0-share) — or anything other than 1 — is a
    -- broken legal record and MUST RAISE. (The old `v_frac_sum = 0` acceptance
    -- wrongly let a zero-ownership apartment commit.)
    IF v_frac_sum <> v_lcm THEN
      RAISE EXCEPTION
        'Sum of ownership shares must equal the whole (1) for apartment %, got %/%',
        v_apartment_id, v_frac_sum, v_lcm;
    END IF;
  ELSE
    -- Overflow fallback: numeric equality. EFFECTIVELY UNREACHABLE from the
    -- product path — the API edge (SetOwnershipsInput) bounds share_denominator
    -- at 1e6, so L = LCM of the owner denominators always stays inside the
    -- c_lcm_cap and the EXACT integer path above is taken. This branch only
    -- fires for a raw/legacy insert with a pathologically large denominator set.
    --
    -- FIX 3: REQUIRE EXACTLY 1 — no epsilon. Reduced rational fractions summing
    -- to 1 are EXACT in `numeric` (arbitrary precision), so `round(...,12)` only
    -- ever served to MASK a near-1 sum that is not actually the whole. Drop the
    -- rounding and the `<> 0` escape: a non-empty owner set (v_owner_rows > 0)
    -- that does not sum to exactly 1 MUST RAISE (mirrors the integer path).
    SELECT COALESCE(SUM(share_numerator::numeric / share_denominator::numeric), 0)
    INTO v_num_sum
    FROM ownerships
    WHERE apartment_id = v_apartment_id AND ended_at IS NULL AND relationship = 'owner';

    IF v_num_sum <> 1::numeric THEN
      RAISE EXCEPTION
        'Sum of ownership shares must equal the whole (1) for apartment %, got %',
        v_apartment_id, v_num_sum;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger BINDING (trg_ownerships_sum_check, FOR EACH ROW DEFERRABLE INITIALLY
-- DEFERRED) is UNCHANGED — CREATE OR REPLACE FUNCTION rebinds the existing
-- trigger; we do NOT drop/recreate it.

-- 3. pct → fraction BACK-COMPAT derivation (BEFORE INSERT OR UPDATE, row-level).
--
--    A legacy/raw writer that sets only `ownership_pct` (the pre-S3b way) and
--    NOT the new fraction columns lands on the column DEFAULTs (0 / 10000).
--    That fraction is 0/10000 = 0, so a non-empty owner set would sum to 0 and
--    the DEFERRED sum trigger above would (correctly, for a real zero-share
--    owner) RAISE at COMMIT. But a row that carried pct = 100 the legacy way is
--    NOT a zero-share owner — it is the canonical "whole" written in the old
--    representation. This BEFORE trigger populates the canonical fraction from
--    pct ONLY when the fraction columns are still at their exact DEFAULT
--    sentinel (0 / 10000), i.e. the writer did not set them. It is the DB-layer
--    mirror of the service's derive-on-write (pct → round(pct*100)/10000).
--
--    WHY THIS IS SAFE / does not weaken anything:
--      * The PRODUCT path (Zod → OwnershipsService) ALWAYS sets the fraction
--        explicitly (shareNumerator/shareDenominator non-default), so this
--        BEFORE trigger is a NO-OP there — the guard (num=0 AND den=10000) is
--        false, the row keeps its explicit fraction.
--      * The DEFERRED constraint trigger trg_ownerships_sum_check STILL runs at
--        COMMIT and STILL enforces fraction sum = 1 over owner rows. This
--        trigger only POPULATES; it never validates and never bypasses the sum
--        check. A pct-only split that does NOT sum to the whole (e.g. two
--        50.00 rows → 5000/10000 each = sum 1, OK; but 50.00 + 40.00 →
--        5000+4000 = 9000/10000 ≠ 1) is still REJECTED by the sum trigger.
--      * An explicit real 0-share owner written as pct 0 stays 0/10000 and, if
--        it is the sole/active owner set, is still rejected by the sum trigger
--        (non-empty owner set summing to 0 RAISES). A renter (relationship
--        'renter', pct 0) stays 0/10000 and is EXCLUDED by the relationship
--        filter in the sum trigger — unchanged.
--      * Ordering: this is a row-level BEFORE trigger, so it fires and rewrites
--        NEW *before* the row is written; the DEFERRABLE INITIALLY DEFERRED
--        constraint trigger fires AFTER, at COMMIT, on the already-populated
--        fraction. Population precedes validation — correct.
CREATE OR REPLACE FUNCTION trigger_derive_ownership_fraction()
RETURNS TRIGGER
SET search_path = pg_temp, public
AS $$
BEGIN
  -- Only derive when the fraction columns are at their exact DEFAULT sentinel
  -- (a pct-only writer didn't set them) AND a pct is present to derive from.
  IF NEW.share_numerator = 0
     AND NEW.share_denominator = 10000
     AND NEW.ownership_pct IS NOT NULL THEN
    NEW.share_numerator := round(NEW.ownership_pct * 100)::bigint;
    NEW.share_denominator := 10000;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ownerships_derive_fraction
  BEFORE INSERT OR UPDATE ON ownerships
  FOR EACH ROW EXECUTE FUNCTION trigger_derive_ownership_fraction();
