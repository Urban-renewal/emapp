-- 0010: security and performance hardening
--
-- Problem: buildings/apartments use multi-level nested subqueries in their RLS
-- policies (apartments → buildings → projects → org_id). Each query that touches
-- apartments runs two extra sub-selects per row, which destroys performance at scale.
--
-- Fix: denormalize org_id onto both tables, replace the nested policies with a
-- single direct column check (same pattern used by every other tenant table).
--
-- Design note: org_id is NOT auto-filled by a trigger. Application code (withTenant)
-- always has orgId in context and must pass it explicitly when creating buildings or
-- apartments. This keeps data flow explicit, FK constraints intact, and behavior
-- predictable (triggers that fire before FK checks mask FK violations).
--
-- All DDL statements are idempotent (IF NOT EXISTS / IF EXISTS guards) so
-- concurrent migrate() calls from parallel test workers are safe.

-- ─── buildings: add org_id column ────────────────────────────────────────────

ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE RESTRICT;

-- Back-fill from projects (no-op if org_id is already filled)
UPDATE buildings
SET org_id = (SELECT org_id FROM projects WHERE id = buildings.project_id)
WHERE org_id IS NULL;

-- Enforce NOT NULL now that all rows are filled
ALTER TABLE buildings ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_buildings_org ON buildings(org_id)
  WHERE archived_at IS NULL;

-- Replace the nested subquery RLS policy with a direct column check
DROP POLICY IF EXISTS tenant_isolation ON buildings;

CREATE POLICY tenant_isolation ON buildings
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── apartments: add org_id column ───────────────────────────────────────────

ALTER TABLE apartments
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE RESTRICT;

-- Back-fill via buildings → projects (no-op if already filled)
UPDATE apartments
SET org_id = (
  SELECT p.org_id
  FROM projects p
  JOIN buildings b ON b.project_id = p.id
  WHERE b.id = apartments.building_id
)
WHERE org_id IS NULL;

ALTER TABLE apartments ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_apartments_org ON apartments(org_id)
  WHERE archived_at IS NULL;

-- Replace the two-level nested subquery RLS policy with a direct column check
DROP POLICY IF EXISTS tenant_isolation ON apartments;

CREATE POLICY tenant_isolation ON apartments
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── missing indexes on actor / uploader columns ──────────────────────────────

CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
CREATE INDEX IF NOT EXISTS idx_notes_created_by ON notes(created_by);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by ON documents(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_contractors_created_by ON contractors(created_by);
CREATE INDEX IF NOT EXISTS idx_task_assignees_assigned_by ON task_assignees(assigned_by);
CREATE INDEX IF NOT EXISTS idx_project_assignments_assigned_by ON project_assignments(assigned_by);

-- ─── organizations.slug format CHECK ─────────────────────────────────────────
-- Slugs must be lowercase alphanumeric + hyphens, no leading/trailing hyphen,
-- at least 2 characters (letter start, alnum end).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_slug_format'
      AND conrelid = 'organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_slug_format
      CHECK (slug ~ '^[a-z][a-z0-9-]*[a-z0-9]$');
  END IF;
END;
$$;
