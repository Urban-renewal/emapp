-- 0035: building_sections + apartments.unit_type / area_sqm / entrance — D.39
--
-- V11 Track B.S1 (canary).
--
-- Why
-- ────
-- Partner's design (MEAPP_design/data.jsx:146-248,
-- MEAPP_design/EMAPP - Spec for Backend.html §Apartment) models
-- real-world urban-renewal projects as buildings with multiple
-- SECTIONS (entrances), where each section can have its own kind
-- (residential / office / retail / mixed), floor count, unit count,
-- and even its own parcel (gush / helka). Apartments inside a section
-- can also be non-residential (shop / office / mixed) — captured via
-- apartments.unit_type. Without these, the AddProjectModal 3-step
-- wizard (Track A.S6 depends on Track B.S2) cannot model a real
-- project; the BE would degrade the form, contradicting the locked
-- product directive ("מוצר מקצועי, לא דרך מהירה").
--
-- D.39 scope: ADDITIVE only.
--   - New table building_sections.
--   - New nullable columns on apartments, with safe defaults.
--   - No data migration. Existing apartments backfill to
--     unit_type = 'apt' (the pre-D.39 implicit-residential semantics).
--
-- RLS template
-- ────────────
-- Template B — RLS via parent — per D.24 + the explicit revert in
-- migration 0011 (buildings/apartments deliberately do NOT carry a
-- denormalised org_id; "a denormalised org_id that can drift from its
-- parent's is a tenant-isolation hazard"). The sanctioned pattern for
-- a child of buildings is therefore parent-chain isolation:
--   section.building_id IN (buildings of projects of current org)
-- Indexes from 0011 (idx_projects_org, idx_buildings_project_id) keep
-- the chain sub-1ms through 100+ orgs (spec doc 04c §10.5).
--
-- Enum discipline
-- ───────────────
-- D.39 explicit: kind + unit_type are "enum-checked at app level".
-- We therefore store them as plain text and enforce the closed set
-- (residential|office|retail|mixed for sections; apt|shop|office|mixed
-- for apartments) at the Zod boundary. No DB-level CHECK is added in
-- this canary: it would force a schema migration every time the enum
-- grows, and the existing pattern for tasks.type (collaboration.ts:101)
-- already trusts the Zod boundary. A belt-and-suspenders CHECK can be
-- added in a separate small migration if a future audit requires it
-- (same posture as 0034 added the SA-8 CHECK for provider_audit_log
-- after the fact).
--
-- GRANT
-- ─────
-- SELECT + INSERT + UPDATE for app_user. No DELETE — soft delete via
-- archived_at (matches mapping_templates / import_jobs / owners).
-- Provider tier (BYPASSRLS) retains hard-delete capability.
--
-- Reversibility
-- ─────────────
-- HIGH. Manual rollback verified locally and pasted in the PR
-- description:
--   DROP TABLE building_sections;
--   ALTER TABLE apartments
--     DROP COLUMN entrance,
--     DROP COLUMN area_sqm,
--     DROP COLUMN unit_type;
-- (Plus delete the journal entry for idx 35.) Existing data unaffected:
-- the new apartments columns default to NULL / 'apt' for legacy rows;
-- dropping them returns the table to its pre-0035 shape.

-- ════════════════════ building_sections ═════════════════════════════
CREATE TABLE IF NOT EXISTS building_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id uuid NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,

  -- Human-visible entrance label ("א" / "ב" / "Main") — optional;
  -- many small buildings have a single unnamed entrance.
  entrance    text,

  -- Closed enum at the Zod boundary:
  --   residential | office | retail | mixed
  kind        text NOT NULL,

  -- Optional structural data — populated as the survey progresses.
  floors      integer,
  unit_count  integer,

  -- Optional own-parcel data: a sectioned project can have parcels
  -- that differ from the building's primary gush/helka (e.g. a
  -- commercial ground floor on a different parcel from the
  -- residential floors above).
  gush        text,
  helka       text,

  -- Free-text section notes (sized-bounded at Zod). Distinct from
  -- buildings.notes which describes the whole building.
  notes       text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- Single hot lookup is "all live sections for a building".
CREATE INDEX IF NOT EXISTS idx_building_sections_building
  ON building_sections (building_id)
  WHERE archived_at IS NULL;

-- ─── RLS (Template B — via parent; see header) ──────────────────────
ALTER TABLE building_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE building_sections FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'building_sections'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON building_sections
      USING (
        building_id IN (
          SELECT id FROM buildings
          WHERE project_id IN (
            SELECT id FROM projects
            WHERE org_id = current_setting('app.organization_id', true)::uuid
          )
        )
      )
      WITH CHECK (
        building_id IN (
          SELECT id FROM buildings
          WHERE project_id IN (
            SELECT id FROM projects
            WHERE org_id = current_setting('app.organization_id', true)::uuid
          )
        )
      );
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; soft delete via archived_at) ────
GRANT SELECT, INSERT, UPDATE ON building_sections TO app_user;
REVOKE DELETE ON building_sections FROM app_user;

-- ════════════════════ apartments — D.39 additive columns ═══════════
--
-- unit_type:
--   NOT NULL DEFAULT 'apt' — existing rows backfill to the implicit
--   residential semantics they had pre-D.39. Closed enum at the Zod
--   boundary (apt | shop | office | mixed).
--
-- area_sqm:
--   Nullable numeric(10,2). Distinct from the pre-existing size_sqm:
--   per partner's spec (EMAPP - Spec for Backend.html §Apartment),
--   `area_sqm` is the "registered area" pulled from the parcel record;
--   `size_sqm` (already on the table) is the self-declared measurement.
--   They can legally differ, so they live in distinct columns.
--
-- entrance:
--   Nullable text — the entrance label this apartment belongs to
--   (mirrors building_sections.entrance so a hand-keyed addition
--   without a full section row is still meaningful).
ALTER TABLE apartments
  ADD COLUMN IF NOT EXISTS unit_type text NOT NULL DEFAULT 'apt',
  ADD COLUMN IF NOT EXISTS area_sqm  numeric(10,2),
  ADD COLUMN IF NOT EXISTS entrance  text;
