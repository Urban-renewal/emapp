-- ════════════════ 0082 · proposals.* permission family (Approval Inbox) ═════
-- Owner-directed authz tightening. Introduces the `proposals.*` permission
-- family and grants it to the manager-and-above system roles so the
-- Approval-Inbox controller (apps/api/src/modules/proposals/proposals.controller
-- .ts) can gate its routes on a DEDICATED family instead of BORROWING
-- `signature_requests.*` (which became semantically wrong once non-signature
-- proposal kinds — e.g. `task.create` — landed).
--
-- Grants:
--   • proposals.read    — list the inbox
--   • proposals.approve — one-click confirm a draft
--   • proposals.reject  — dismiss a draft
-- to the OWNER, ADMIN, and MANAGER system roles ONLY. The Approval Inbox is a
-- manager-only surface (ProposalsService.requireManager is the binding gate), so
-- the family is DELIBERATELY NOT granted to agent / viewer / external_read — a
-- holder who could not pass `requireManager` would hold a permission they could
-- never use (the very inconsistency this change removes). This mirrors the code
-- source of truth (apps/api/src/common/authz/system-roles.ts — ADMIN + MANAGER
-- sets explicitly add the family; OWNER holds it via the full catalog; AGENT +
-- VIEWER explicitly exclude it). The pinning tests (system-roles.spec.ts +
-- permissions.spec.ts + the DB seed test iam-foundation-schema.spec.ts) assert
-- DB == code, so any drift goes red.
--
-- Idempotent + re-runnable: ON CONFLICT (role_id, permission) DO NOTHING.
-- Reversibility: HIGH. DELETE FROM role_permissions WHERE permission LIKE
-- 'proposals.%' restores the prior state (no schema change, grant-only).
-- Hand-authored (drizzle-kit is unusable here — see packages/db/CLAUDE.md); a
-- meta/_journal.json entry is added in the same commit.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('proposals.read'),
  ('proposals.approve'),
  ('proposals.reject')
) AS p(permission)
WHERE r.org_id IS NULL
  AND r.is_system = true
  AND r.key IN ('owner', 'admin', 'manager')
ON CONFLICT (role_id, permission) DO NOTHING;
