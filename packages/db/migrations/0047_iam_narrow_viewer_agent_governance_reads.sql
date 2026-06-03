-- ════════════════════ 0047 · narrow Viewer/Agent governance reads ══════════
-- Security / least-privilege (gate-6). The earlier model derived Viewer from
-- "every *.read" and Agent from "all operational", which SWEPT IN the GOVERNANCE
-- reads `audit.read`, `members.read`, `roles.read`, `org.settings.read`:
--   • Viewer (read-only) could read the AUDIT LOG, ORG SETTINGS, ROLE CONFIG,
--     and the MEMBER ROSTER.
--   • Agent (scoped field user) could read the AUDIT LOG.
-- Legacy policy had `audit:MGR` / `members:MGR` (governance reads were Manager+).
-- The members black-box contract test + the sidebar role-gating e2e both pin the
-- narrower scope. This migration removes those grants from the seeded roles to
-- match the corrected `system-roles.ts` definitions.
--
-- Manager/Admin/Owner are UNAFFECTED: they reach `members.read` + `audit.read`
-- via the `export.run ⇒ <resource>.read` implication closure (resolved at request
-- time), so the sidebar Members/Audit links still show for them.

-- Agent: remove audit.read (the only governance read it held).
DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND r.org_id IS NULL AND r.is_system = true AND r.key = 'agent'
  AND rp.permission = 'audit.read';

-- Viewer: remove the governance reads (members / roles / audit / org settings).
DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND r.org_id IS NULL AND r.is_system = true AND r.key = 'viewer'
  AND rp.permission IN ('members.read', 'roles.read', 'audit.read', 'org.settings.read');
