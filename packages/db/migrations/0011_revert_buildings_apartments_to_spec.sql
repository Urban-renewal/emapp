-- 0011: revert buildings/apartments to the locked Phase 1 design (spec doc 04c §4, §10.5; P1.11 DoD)
--
-- Migration 0010 denormalized org_id onto buildings/apartments and switched their
-- RLS to Template A. The locked spec deliberately keeps these tables WITHOUT org_id
-- and uses Template B (RLS via parent). Rationale for reverting (security base layer):
--   - A denormalized org_id that can drift from its parent's org_id is a tenant-
--     isolation hazard: Template A would trust the local (possibly stale) value.
--   - Template B has exactly one source of truth (projects.org_id) — zero drift.
--   - Spec proves Template B is sub-1ms through 100+ orgs with the indexes below.
--
-- This migration is idempotent (IF EXISTS / IF NOT EXISTS guards).

-- ─── restore Template B RLS on buildings ─────────────────────────────────────

DROP POLICY IF EXISTS tenant_isolation ON buildings;

CREATE POLICY tenant_isolation ON buildings
  USING (
    project_id IN (
      SELECT id FROM projects
      WHERE org_id = current_setting('app.organization_id', true)::uuid
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT id FROM projects
      WHERE org_id = current_setting('app.organization_id', true)::uuid
    )
  );

-- ─── restore Template B RLS on apartments ────────────────────────────────────

DROP POLICY IF EXISTS tenant_isolation ON apartments;

CREATE POLICY tenant_isolation ON apartments
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

-- ─── drop the denormalized org_id columns + their indexes (0010 additions) ────

DROP INDEX IF EXISTS idx_buildings_org;
DROP INDEX IF EXISTS idx_apartments_org;

-- Dropping the column also drops its FK to organizations.
ALTER TABLE apartments DROP COLUMN IF EXISTS org_id;
ALTER TABLE buildings DROP COLUMN IF EXISTS org_id;

-- ─── guarantee the spec's Template-B support indexes exist (sub-1ms claim) ────
-- Non-partial indexes so the RLS subqueries (which do NOT filter archived_at)
-- are fully index-served. Existing partial indexes don't cover the unfiltered
-- IN-subqueries used by the policies.

CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_buildings_project_id ON buildings(project_id);
CREATE INDEX IF NOT EXISTS idx_apartments_building_id ON apartments(building_id);
