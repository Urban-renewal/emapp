-- P1.11: Row-Level Security policies for all multi-tenant tables
-- Pattern: FORCE ROW LEVEL SECURITY so even table owner respects policy
-- current_setting('app.organization_id', true) returns NULL if not set → policy evaluates false → no rows

-- ─── organizations ───────────────────────────────────────────────────────────
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON organizations
  USING (id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (id = current_setting('app.organization_id', true)::uuid);

-- ─── users ───────────────────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON users
  USING (
    EXISTS (
      SELECT 1 FROM memberships
      WHERE memberships.user_id = users.id
        AND memberships.org_id = current_setting('app.organization_id', true)::uuid
        AND memberships.revoked_at IS NULL
    )
  );

-- ─── memberships ─────────────────────────────────────────────────────────────
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON memberships
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── projects ────────────────────────────────────────────────────────────────
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON projects
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── buildings ───────────────────────────────────────────────────────────────
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE buildings FORCE ROW LEVEL SECURITY;

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

-- ─── apartments ──────────────────────────────────────────────────────────────
ALTER TABLE apartments ENABLE ROW LEVEL SECURITY;
ALTER TABLE apartments FORCE ROW LEVEL SECURITY;

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

-- ─── owners ──────────────────────────────────────────────────────────────────
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON owners
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── ownerships ──────────────────────────────────────────────────────────────
ALTER TABLE ownerships ENABLE ROW LEVEL SECURITY;
ALTER TABLE ownerships FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ownerships
  USING (
    owner_id IN (
      SELECT id FROM owners
      WHERE org_id = current_setting('app.organization_id', true)::uuid
    )
  )
  WITH CHECK (
    owner_id IN (
      SELECT id FROM owners
      WHERE org_id = current_setting('app.organization_id', true)::uuid
    )
  );

-- ─── contractors ─────────────────────────────────────────────────────────────
ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractors FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON contractors
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── shares ──────────────────────────────────────────────────────────────────
ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE shares FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON shares
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

-- ─── tasks ───────────────────────────────────────────────────────────────────
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tasks
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── task_assignees ──────────────────────────────────────────────────────────
ALTER TABLE task_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_assignees FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON task_assignees
  USING (
    task_id IN (
      SELECT id FROM tasks
      WHERE org_id = current_setting('app.organization_id', true)::uuid
    )
  )
  WITH CHECK (
    task_id IN (
      SELECT id FROM tasks
      WHERE org_id = current_setting('app.organization_id', true)::uuid
    )
  );

-- ─── notifications ───────────────────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

-- Notifications are org-scoped AND user-scoped (each user sees only their own)
CREATE POLICY tenant_isolation ON notifications
  USING (
    org_id = current_setting('app.organization_id', true)::uuid
    AND user_id = current_setting('app.user_id', true)::uuid
  )
  WITH CHECK (
    org_id = current_setting('app.organization_id', true)::uuid
    AND user_id = current_setting('app.user_id', true)::uuid
  );

-- ─── project_assignments ─────────────────────────────────────────────────────
ALTER TABLE project_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON project_assignments
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

-- ─── documents ───────────────────────────────────────────────────────────────
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON documents
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── signatures ──────────────────────────────────────────────────────────────
ALTER TABLE signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON signatures
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── notes ───────────────────────────────────────────────────────────────────
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notes
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- ─── audit_log ───────────────────────────────────────────────────────────────
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_log
  USING (org_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);

-- Provider tables (provider_users, provider_audit_log) are exempt from app_user RLS
-- because app_user has no grants on those tables at all (enforced via GRANT in 0001)
