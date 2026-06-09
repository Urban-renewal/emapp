-- ════════════════════ 0053 · Manager gains member administration ═══════════
-- Owner-approved Gate-2 (role taxonomy) + Gate-6 (migration) change. Grants the
-- MANAGER system role the member-administration permissions so a Manager can
-- invite / update / remove org users. Previously only Owner/Admin held these:
-- MANAGER was derived as ALL_OPERATIONAL, which excludes every `members.`/
-- `roles.`/`org.` (governance) permission.
--
-- Scope of the grant is EXACTLY member CRUD:
--   • members.invite
--   • members.update
--   • members.remove
-- NOT roles.* and NOT org.* — role-administration + org-governance stay
-- Owner/Admin-only. `members.read` is intentionally NOT seeded: Manager reaches
-- it via the `export.run ⇒ members.read` implication closure (resolved at
-- request time), exactly as Admin/Owner do (see 0047).
--
-- This is a literal mirror of the code source of truth
-- (apps/api/src/common/authz/system-roles.ts — MANAGER set). The pinning test
-- (system-roles.spec.ts + the DB seed test) asserts DB == code, so drift goes
-- red. Hand-authored (drizzle-kit is unusable here — see packages/db/CLAUDE.md);
-- a meta/_journal.json entry is added in the same commit.
--
-- Idempotent + re-runnable: ON CONFLICT (role_id, permission) DO NOTHING.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('members.invite'),
  ('members.update'),
  ('members.remove')
) AS p(permission)
WHERE r.org_id IS NULL
  AND r.is_system = true
  AND r.key = 'manager'
ON CONFLICT (role_id, permission) DO NOTHING;
