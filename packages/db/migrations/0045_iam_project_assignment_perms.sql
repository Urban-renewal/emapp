-- 0045 — grant the new project_assignments.* permissions to the system roles.
-- Restores Manager's ability to staff projects (legacy MGR), which the authz
-- cutover lost by mapping project-assignment onto org-role governance.
-- project_assignments.read → owner, admin, manager, agent, viewer (legacy read: ALL)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'project_assignments.read'
FROM roles r
WHERE r.org_id IS NULL AND r.is_system = true
  AND r.key IN ('owner','admin','manager','agent','viewer')
ON CONFLICT (role_id, permission) DO NOTHING;

-- project_assignments.manage → owner, admin, manager (legacy create/update/delete: MGR)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'project_assignments.manage'
FROM roles r
WHERE r.org_id IS NULL AND r.is_system = true
  AND r.key IN ('owner','admin','manager')
ON CONFLICT (role_id, permission) DO NOTHING;
