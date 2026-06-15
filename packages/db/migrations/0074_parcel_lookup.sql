-- 0074: parcel_lookup — P3b "pluggable parcel-data provider + LocalMapi lookup"
-- (docs/DESIGN-phase3-parcel-autosetup.md §2/§3/§5/§6 P3b/§7.1 decision-1).
--
-- `parcel_lookup` is a GLOBAL reference table: the bulk-מפ"י open-data parcels
-- dataset (data.gov.il, open-government license) loaded locally —
-- block/parcel(+sub) → city + centroid. LocalMapiParcelDataProvider resolves a
-- parcel-setup's גוש/חלקה against it with ZERO runtime egress.
--
-- ── WHY NO org_id AND NO RLS (deliberate — unlike every tenant table) ────────
-- This table is a PUBLIC NATIONAL RECORD: land-registration numbers, city
-- names and parcel centroids that מפ"י publishes openly for the whole country.
-- It contains ZERO tenant data and ZERO PII, and is byte-identical for every
-- org — there is nothing to isolate, so an org_id column and an RLS policy
-- would only fake a tenancy that doesn't exist. The protection model is
-- WRITE-protection instead of read-isolation:
--   * app_user (the RLS application role) gets SELECT ONLY — explicitly
--     revoking the INSERT/UPDATE/DELETE that 0009's ALTER DEFAULT PRIVILEGES
--     would otherwise auto-grant;
--   * writes happen exclusively through the owner-role loader script
--     (packages/db/scripts/load-parcel-lookup.ts — monthly bulk refresh).
--
-- This migration:
--   1. CREATE TABLE parcel_lookup with a UNIQUE NULLS NOT DISTINCT constraint
--      on (block_number, parcel_number, sub_parcel) — exact duplicates 23505
--      even when sub_parcel is NULL (PG16), and it is the loader's UPSERT
--      conflict target.
--   2. GRANT SELECT / REVOKE writes for app_user (see above).
--   3. ALTER TABLE parcel_setups ADD provider_city + provider_status (what the
--      P3b create-time provider lookup yielded: 'found' stamps source=the
--      provider's id + provider_city; 'not_found' leaves source='manual').
--
-- Reversibility: HIGH. ALTER TABLE parcel_setups DROP COLUMN provider_city,
-- DROP COLUMN provider_status; DROP TABLE parcel_lookup restores prior state.
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

-- ════════════════════ parcel_lookup (GLOBAL — no org_id, no RLS) ════════════
CREATE TABLE IF NOT EXISTS parcel_lookup (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- PUBLIC land-registration numbers (גוש/חלקה/תת) — not PII.
  block_number  text NOT NULL,
  parcel_number text NOT NULL,
  -- NULL = the whole-parcel record (no תת-חלקה).
  sub_parcel    text,

  city          text,
  centroid_lat  double precision,
  centroid_lng  double precision,

  -- Uniqueness over the natural key. NULLS NOT DISTINCT (PG16) so a duplicate
  -- NULL-sub row is rejected too — the loader's idempotent UPSERT depends on
  -- this exact arbiter.
  CONSTRAINT parcel_lookup_block_parcel_sub_key
    UNIQUE NULLS NOT DISTINCT (block_number, parcel_number, sub_parcel)
);

-- ─── grants: app_user reads only; the owner-role loader writes ───────────────
-- 0009's ALTER DEFAULT PRIVILEGES auto-grants SELECT/INSERT/UPDATE/DELETE to
-- app_user on every new table — pare it back to SELECT (public read is fine;
-- the app NEVER writes national reference data).
GRANT SELECT ON parcel_lookup TO app_user;
REVOKE INSERT, UPDATE, DELETE ON parcel_lookup FROM app_user;

-- NOTE: RLS is INTENTIONALLY NOT ENABLED on parcel_lookup (see header — public
-- national record, no tenant data; SELECT-only app surface is the control).

-- ─── parcel_setups: the create-time provider lookup outcome (P3b wiring) ─────
ALTER TABLE parcel_setups ADD COLUMN IF NOT EXISTS provider_city text;
ALTER TABLE parcel_setups ADD COLUMN IF NOT EXISTS provider_status text;
