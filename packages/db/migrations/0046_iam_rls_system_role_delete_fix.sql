-- ════════════════════ 0046 · IAM RLS system-role DELETE fix ═══════════════
-- CRITICAL tenant-isolation hole (gate-6). In 0043 the `tenant_isolation`
-- policies on `roles` and `role_permissions` used a single FOR ALL policy whose
-- USING admitted SYSTEM rows (org_id IS NULL) cross-org so every tenant could
-- READ the seeded roles/permissions. But in Postgres DELETE is authorized by
-- USING ONLY (WITH CHECK does not apply to DELETE) — so any tenant's app_user
-- could DELETE a SYSTEM role / its permissions, wiping them GLOBALLY for ALL
-- orgs. INSERT/UPDATE were correctly blocked by WITH CHECK; only DELETE leaked.
--
-- Fix: scope the cross-org system-row visibility to SELECT ONLY. A FOR ALL
-- policy constrained to own-org rows governs INSERT/UPDATE/DELETE (+ own-org
-- SELECT); a separate FOR SELECT policy re-adds the cross-org system-role read.
-- Postgres OR's permissive policies per-command, so SELECT still sees both
-- own-org and system rows, while DELETE/UPDATE/INSERT are own-org only.
--
-- Pure policy redefinitions on existing tables — no grant/ownership changes,
-- migrator (app_user) unaffected. `role_assignments` is NOT affected (its USING
-- is scope-bound, no cross-org IS NULL admit) and is intentionally untouched.

-- ── roles ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON roles;
DROP POLICY IF EXISTS tenant_read_system ON roles;

-- Own-org rows for ALL commands (INSERT/UPDATE/DELETE + own-org SELECT).
CREATE POLICY tenant_isolation ON roles
  FOR ALL
  USING (
    org_id = current_setting('app.organization_id', true)::uuid
  )
  WITH CHECK (
    org_id = current_setting('app.organization_id', true)::uuid
  );

-- SELECT-only: re-add cross-org read of SYSTEM roles (org_id IS NULL).
CREATE POLICY tenant_read_system ON roles
  FOR SELECT
  USING (
    org_id IS NULL
    OR org_id = current_setting('app.organization_id', true)::uuid
  );

-- ── role_permissions ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON role_permissions;
DROP POLICY IF EXISTS tenant_read_system ON role_permissions;

-- Own-org custom-role perms for ALL commands.
CREATE POLICY tenant_isolation ON role_permissions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.org_id = current_setting('app.organization_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.org_id = current_setting('app.organization_id', true)::uuid
    )
  );

-- SELECT-only: re-add cross-org read of perms whose parent role is system/own-org.
CREATE POLICY tenant_read_system ON role_permissions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND (r.org_id IS NULL
             OR r.org_id = current_setting('app.organization_id', true)::uuid)
    )
  );
