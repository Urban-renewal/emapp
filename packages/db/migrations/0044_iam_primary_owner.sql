-- 0044 — IAM backfill fix: promote each org's PRIMARY manager to Owner.
--
-- The 0043 backfill mapped membership.role → the same-named system role, so the
-- old roles (manager/agent/viewer) produced NO Owner/Admin. After the slice-5a
-- cutover (member/role/assignment administration moved to the Admin/Owner plane)
-- that left every org with NOBODY able to invite members, assign roles, or
-- administer the org. Decision §11.1: the org's first user (its primary manager)
-- is the Owner. This migration realizes that. Idempotent.

-- 1) Promote: the primary manager of each org → Owner (org scope).
INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_by, granted_at)
SELECT m.user_id, r.id, 'org', m.org_id, m.invited_by, m.created_at
FROM memberships m
JOIN roles r ON r.org_id IS NULL AND r.is_system = true AND r.key = 'owner'
WHERE m.revoked_at IS NULL AND m.is_primary = true AND m.role = 'manager'
ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING;

-- 2) Remove the now-redundant Manager org-assignment for those promoted users
--    (Owner ⊇ Manager) so each has one canonical org role.
DELETE FROM role_assignments ra
USING memberships m, roles rm
WHERE ra.user_id = m.user_id
  AND ra.scope_type = 'org' AND ra.scope_id = m.org_id
  AND ra.role_id = rm.id AND rm.org_id IS NULL AND rm.is_system = true AND rm.key = 'manager'
  AND m.is_primary = true AND m.role = 'manager' AND m.revoked_at IS NULL;
