-- 0043: Enterprise IAM foundation (IAM-DESIGN §10 steps 1–2) — Slice 1.
--
-- PURELY ADDITIVE / Gate-6. Adds the IAM data model (roles + role_permissions
-- + role_assignments), SSO/SCIM identity columns on users, RLS, grants, the
-- seeded 6 system roles + permission sets (§4), and the backfill from
-- memberships + project_assignments (§10 step 2). ZERO behavior change:
-- policy.ts stays the live enforcement engine; nothing reads these tables at
-- request time yet.
--
-- Hand-authored (drizzle-kit is unusable here — see packages/db/CLAUDE.md);
-- a meta/_journal.json entry is added in the same commit.
--
-- The seeded permission rows are a literal mirror of the code source of truth
-- (apps/api/src/common/authz/system-roles.ts + permissions.ts). A pinning test
-- (apps/api/src/common/authz/system-roles.spec.ts + the DB seed test) asserts
-- DB == code, so any drift goes red.

-- ════════════════════ users — identity columns (§3) ═══════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS idp text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS provisioning_source text NOT NULL DEFAULT 'local';

-- ════════════════════ roles ═══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = system role (cross-org). Non-null = a custom role owned by an org.
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Invariant: system roles have NULL org_id; custom roles have an org.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'roles_system_org_consistent' AND conrelid = 'roles'::regclass
  ) THEN
    ALTER TABLE roles ADD CONSTRAINT roles_system_org_consistent
      CHECK ((is_system AND org_id IS NULL) OR (NOT is_system AND org_id IS NOT NULL));
  END IF;
END;
$$;

-- System roles: globally unique key. Custom roles: unique key per org.
CREATE UNIQUE INDEX IF NOT EXISTS roles_system_key_unique
  ON roles (key) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS roles_org_key_unique
  ON roles (org_id, key) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_roles_org ON roles (org_id);

-- ════════════════════ role_permissions ════════════════════════════════════
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_pk
  ON role_permissions (role_id, permission);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions (role_id);

-- ════════════════════ role_assignments ════════════════════════════════════
CREATE TABLE IF NOT EXISTS role_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  scope_type text NOT NULL,
  scope_id   uuid NOT NULL,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'role_assignments_scope_type_valid'
      AND conrelid = 'role_assignments'::regclass
  ) THEN
    ALTER TABLE role_assignments ADD CONSTRAINT role_assignments_scope_type_valid
      CHECK (scope_type IN ('org','project'));
  END IF;
END;
$$;

-- One assignment per (user, role, scope) — idempotent backfill + no dup grants.
CREATE UNIQUE INDEX IF NOT EXISTS role_assignments_unique
  ON role_assignments (user_id, role_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_user ON role_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_scope ON role_assignments (scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_role ON role_assignments (role_id);

-- ════════════════════ RLS ═════════════════════════════════════════════════
-- Mirrors migration 0004 / 0028 FORCE pattern. System roles (org_id IS NULL)
-- are readable cross-org; org-owned rows are tenant-isolated.

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='roles' AND policyname='tenant_isolation'
  ) THEN
    -- SELECT: own-org rows OR any system role. WRITE: own-org custom roles only
    -- (system roles are seed-managed via BYPASSRLS; app_user can't mutate them).
    CREATE POLICY tenant_isolation ON roles
      USING (
        org_id IS NULL
        OR org_id = current_setting('app.organization_id', true)::uuid
      )
      WITH CHECK (
        org_id = current_setting('app.organization_id', true)::uuid
      );
  END IF;
END;
$$;

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='role_permissions' AND policyname='tenant_isolation'
  ) THEN
    -- Readable when the parent role is readable (own-org or system). Writable
    -- only for own-org custom roles (system role perms are seed-managed).
    CREATE POLICY tenant_isolation ON role_permissions
      USING (
        EXISTS (
          SELECT 1 FROM roles r
          WHERE r.id = role_permissions.role_id
            AND (r.org_id IS NULL
                 OR r.org_id = current_setting('app.organization_id', true)::uuid)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM roles r
          WHERE r.id = role_permissions.role_id
            AND r.org_id = current_setting('app.organization_id', true)::uuid
        )
      );
  END IF;
END;
$$;

ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='role_assignments' AND policyname='tenant_isolation'
  ) THEN
    -- An assignment belongs to a tenant via its scope: org-scope rows match the
    -- current org directly; project-scope rows match when the project is in the
    -- current org. (scope_id holds org_id for 'org', project_id for 'project'.)
    CREATE POLICY tenant_isolation ON role_assignments
      USING (
        (scope_type = 'org'
          AND scope_id = current_setting('app.organization_id', true)::uuid)
        OR (scope_type = 'project'
          AND scope_id IN (
            SELECT id FROM projects
            WHERE org_id = current_setting('app.organization_id', true)::uuid
          ))
      )
      WITH CHECK (
        (scope_type = 'org'
          AND scope_id = current_setting('app.organization_id', true)::uuid)
        OR (scope_type = 'project'
          AND scope_id IN (
            SELECT id FROM projects
            WHERE org_id = current_setting('app.organization_id', true)::uuid
          ))
      );
  END IF;
END;
$$;

-- ════════════════════ grants ══════════════════════════════════════════════
-- app_user: full DML on assignments + custom-role rows (RLS scopes them).
-- System roles are inserted/maintained by the seed below via the migrator's
-- BYPASSRLS connection, not by app_user. (ALTER DEFAULT PRIVILEGES from 0009
-- already covers new tables, but assert explicitly for clarity + idempotency.)
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_assignments TO app_user;

-- ════════════════════ seed: 6 system roles + permission sets (§4) ══════════
-- Idempotent: upsert role by key, then re-sync its permission set (delete rows
-- no longer in the set, insert missing). Runs under the migrator's BYPASSRLS
-- role so system roles (org_id IS NULL) can be written.

-- Upsert the 6 system roles.
INSERT INTO roles (org_id, key, name, description, is_system) VALUES
  (NULL, 'owner',         'Owner',         'Full control including billing, ownership transfer, and org deletion.', true),
  (NULL, 'admin',         'Admin',         'Members, roles, settings, security policy, and all operational actions (incl. reveal PII + export). No billing/transfer/delete-org.', true),
  (NULL, 'manager',       'Manager',       'All operational actions on scope, including reveal PII and export. No member/role administration.', true),
  (NULL, 'agent',         'Agent',         'Read plus scoped writes on assigned projects. No project/owner creation, no export; reveal PII only if granted per assignment.', true),
  (NULL, 'viewer',        'Viewer',        'Read-only across the org. PII masked (no reveal).', true),
  (NULL, 'external_read', 'External-Read', 'Project-scoped read of the shared subset for external stakeholders. No owner PII, no internals.', true)
ON CONFLICT (key) WHERE org_id IS NULL
DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, is_system = true, updated_at = now();

-- Seed each role's permission set. We stage the desired (key, permission) pairs
-- in a temp table, then sync role_permissions to exactly match it for system
-- roles — idempotent + drift-correcting.
CREATE TEMP TABLE _iam_seed (role_key text NOT NULL, permission text NOT NULL) ON COMMIT DROP;

INSERT INTO _iam_seed (role_key, permission) VALUES
  -- owner (64) — every permission
  ('owner','projects.read'),('owner','projects.create'),('owner','projects.update'),('owner','projects.archive'),
  ('owner','buildings.read'),('owner','buildings.create'),('owner','buildings.update'),('owner','buildings.archive'),
  ('owner','apartments.read'),('owner','apartments.create'),('owner','apartments.update'),('owner','apartments.archive'),
  ('owner','owners.read'),('owner','owners.create'),('owner','owners.update'),('owner','owners.archive'),('owner','owners.reveal_pii'),
  ('owner','ownerships.read'),('owner','ownerships.set'),
  ('owner','documents.read'),('owner','documents.create'),('owner','documents.update'),('owner','documents.archive'),('owner','documents.download'),
  ('owner','signature_requests.read'),('owner','signature_requests.send'),('owner','signature_requests.cancel'),
  ('owner','tasks.read'),('owner','tasks.create'),('owner','tasks.update'),('owner','tasks.archive'),
  ('owner','notes.read'),('owner','notes.create'),('owner','notes.update'),('owner','notes.archive'),
  ('owner','contractors.read'),('owner','contractors.create'),('owner','contractors.update'),('owner','contractors.archive'),
  ('owner','shares.create'),('owner','shares.revoke'),
  ('owner','imports.read'),('owner','imports.run'),('owner','imports.cancel'),('owner','imports.map'),
  ('owner','mapping_templates.read'),('owner','mapping_templates.manage'),
  ('owner','export.run'),
  ('owner','stats.read'),('owner','audit.read'),
  ('owner','members.read'),('owner','members.invite'),('owner','members.update'),('owner','members.remove'),
  ('owner','roles.read'),('owner','roles.assign'),('owner','roles.revoke'),('owner','roles.manage'),
  ('owner','org.settings.read'),('owner','org.settings.update'),('owner','org.security_policy.manage'),
  ('owner','org.billing.manage'),('owner','org.transfer_ownership'),('owner','org.delete'),

  -- admin (61) — owner minus billing/transfer/delete-org
  ('admin','projects.read'),('admin','projects.create'),('admin','projects.update'),('admin','projects.archive'),
  ('admin','buildings.read'),('admin','buildings.create'),('admin','buildings.update'),('admin','buildings.archive'),
  ('admin','apartments.read'),('admin','apartments.create'),('admin','apartments.update'),('admin','apartments.archive'),
  ('admin','owners.read'),('admin','owners.create'),('admin','owners.update'),('admin','owners.archive'),('admin','owners.reveal_pii'),
  ('admin','ownerships.read'),('admin','ownerships.set'),
  ('admin','documents.read'),('admin','documents.create'),('admin','documents.update'),('admin','documents.archive'),('admin','documents.download'),
  ('admin','signature_requests.read'),('admin','signature_requests.send'),('admin','signature_requests.cancel'),
  ('admin','tasks.read'),('admin','tasks.create'),('admin','tasks.update'),('admin','tasks.archive'),
  ('admin','notes.read'),('admin','notes.create'),('admin','notes.update'),('admin','notes.archive'),
  ('admin','contractors.read'),('admin','contractors.create'),('admin','contractors.update'),('admin','contractors.archive'),
  ('admin','shares.create'),('admin','shares.revoke'),
  ('admin','imports.read'),('admin','imports.run'),('admin','imports.cancel'),('admin','imports.map'),
  ('admin','mapping_templates.read'),('admin','mapping_templates.manage'),
  ('admin','export.run'),
  ('admin','stats.read'),('admin','audit.read'),
  ('admin','members.read'),('admin','members.invite'),('admin','members.update'),('admin','members.remove'),
  ('admin','roles.read'),('admin','roles.assign'),('admin','roles.revoke'),('admin','roles.manage'),
  ('admin','org.settings.read'),('admin','org.settings.update'),('admin','org.security_policy.manage'),

  -- manager (50) — all operational (non-governance), incl. reveal_pii + export
  ('manager','projects.read'),('manager','projects.create'),('manager','projects.update'),('manager','projects.archive'),
  ('manager','buildings.read'),('manager','buildings.create'),('manager','buildings.update'),('manager','buildings.archive'),
  ('manager','apartments.read'),('manager','apartments.create'),('manager','apartments.update'),('manager','apartments.archive'),
  ('manager','owners.read'),('manager','owners.create'),('manager','owners.update'),('manager','owners.archive'),('manager','owners.reveal_pii'),
  ('manager','ownerships.read'),('manager','ownerships.set'),
  ('manager','documents.read'),('manager','documents.create'),('manager','documents.update'),('manager','documents.archive'),('manager','documents.download'),
  ('manager','signature_requests.read'),('manager','signature_requests.send'),('manager','signature_requests.cancel'),
  ('manager','tasks.read'),('manager','tasks.create'),('manager','tasks.update'),('manager','tasks.archive'),
  ('manager','notes.read'),('manager','notes.create'),('manager','notes.update'),('manager','notes.archive'),
  ('manager','contractors.read'),('manager','contractors.create'),('manager','contractors.update'),('manager','contractors.archive'),
  ('manager','shares.create'),('manager','shares.revoke'),
  ('manager','imports.read'),('manager','imports.run'),('manager','imports.cancel'),('manager','imports.map'),
  ('manager','mapping_templates.read'),('manager','mapping_templates.manage'),
  ('manager','export.run'),
  ('manager','stats.read'),('manager','audit.read'),

  -- agent (46) — operational minus projects.create/owners.create/reveal_pii/export
  ('agent','projects.read'),('agent','projects.update'),('agent','projects.archive'),
  ('agent','buildings.read'),('agent','buildings.create'),('agent','buildings.update'),('agent','buildings.archive'),
  ('agent','apartments.read'),('agent','apartments.create'),('agent','apartments.update'),('agent','apartments.archive'),
  ('agent','owners.read'),('agent','owners.update'),('agent','owners.archive'),
  ('agent','ownerships.read'),('agent','ownerships.set'),
  ('agent','documents.read'),('agent','documents.create'),('agent','documents.update'),('agent','documents.archive'),('agent','documents.download'),
  ('agent','signature_requests.read'),('agent','signature_requests.send'),('agent','signature_requests.cancel'),
  ('agent','tasks.read'),('agent','tasks.create'),('agent','tasks.update'),('agent','tasks.archive'),
  ('agent','notes.read'),('agent','notes.create'),('agent','notes.update'),('agent','notes.archive'),
  ('agent','contractors.read'),('agent','contractors.create'),('agent','contractors.update'),('agent','contractors.archive'),
  ('agent','shares.create'),('agent','shares.revoke'),
  ('agent','imports.read'),('agent','imports.run'),('agent','imports.cancel'),('agent','imports.map'),
  ('agent','mapping_templates.read'),('agent','mapping_templates.manage'),
  ('agent','stats.read'),('agent','audit.read'),

  -- viewer (17) — every read permission except owners.reveal_pii
  ('viewer','projects.read'),('viewer','buildings.read'),('viewer','apartments.read'),
  ('viewer','owners.read'),('viewer','ownerships.read'),('viewer','documents.read'),
  ('viewer','signature_requests.read'),('viewer','tasks.read'),('viewer','notes.read'),
  ('viewer','contractors.read'),('viewer','imports.read'),('viewer','mapping_templates.read'),
  ('viewer','stats.read'),('viewer','audit.read'),('viewer','members.read'),
  ('viewer','roles.read'),('viewer','org.settings.read'),

  -- external_read (6) — shared project read subset, no owner PII
  ('external_read','projects.read'),('external_read','buildings.read'),('external_read','apartments.read'),
  ('external_read','documents.read'),('external_read','documents.download'),('external_read','signature_requests.read');

-- Insert missing permission rows for each system role.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, s.permission
FROM _iam_seed s
JOIN roles r ON r.key = s.role_key AND r.org_id IS NULL
ON CONFLICT (role_id, permission) DO NOTHING;

-- Drift-correct: remove any permission on a system role that is no longer in
-- the seed (keeps the seed authoritative across re-runs / schema evolution).
DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND r.org_id IS NULL
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM _iam_seed s
    WHERE s.role_key = r.key AND s.permission = rp.permission
  );

-- ════════════════════ backfill (§10 step 2) ═══════════════════════════════
-- Every ACTIVE membership (revoked_at IS NULL) → one org-scoped role_assignment
-- mapping the legacy role (manager|agent|viewer) to the same-named system role.
-- Idempotent via the unique (user, role, scope) index.
INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_by, granted_at)
SELECT m.user_id, r.id, 'org', m.org_id, m.invited_by, m.created_at
FROM memberships m
JOIN roles r ON r.org_id IS NULL AND r.is_system = true AND r.key = m.role::text
WHERE m.revoked_at IS NULL
ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING;

-- Every ACTIVE project_assignment (unassigned_at IS NULL) → a project-scoped
-- Agent assignment. Idempotent.
INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_by, granted_at)
SELECT pa.user_id, r.id, 'project', pa.project_id, pa.assigned_by, pa.assigned_at
FROM project_assignments pa
JOIN roles r ON r.org_id IS NULL AND r.is_system = true AND r.key = 'agent'
WHERE pa.unassigned_at IS NULL
ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING;
