-- 0013: Hebrew ICU collation (DECISION D.11, P1.10 DoD)
--
-- Without this, ORDER BY on Hebrew name columns sorts by UTF-8 byte order,
-- which produces nonsense lists for Hebrew users (a stated D.11 failure mode).
--
-- Per-column / per-query collation (NOT the DB default — D.11), so English
-- fields keep English ordering.

CREATE COLLATION IF NOT EXISTS he_il_icu (
  provider = icu,
  locale = 'he-IL-x-icu',
  deterministic = false
);

-- Sort-verification: fail the migration loudly if the collation does not
-- order the Hebrew alphabet correctly (alef < bet < tav).
DO $$
DECLARE
  result text;
BEGIN
  SELECT string_agg(n, ',' ORDER BY n COLLATE he_il_icu)
  INTO result
  FROM (VALUES ('תמר'), ('אבי'), ('בן')) AS v(n);

  IF result IS DISTINCT FROM 'אבי,בן,תמר' THEN
    RAISE EXCEPTION 'he_il_icu collation sort verification failed: expected "אבי,בן,תמר", got "%"', result;
  END IF;
END;
$$;

-- Spec §5 name-sort index for the most common Hebrew-ordered list (owners).
CREATE INDEX IF NOT EXISTS idx_owners_org_name
  ON owners (org_id, name COLLATE he_il_icu)
  WHERE archived_at IS NULL;
