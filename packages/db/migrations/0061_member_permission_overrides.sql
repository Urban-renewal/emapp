-- ════════════════════ 0061 · Member permission overrides (P2 Phase 2) ══════
-- Owner-approved Gate-6 (schema) change. Adds the PER-USER override layer that
-- sits ON TOP of a member's role-derived permission set:
--   • effect='grant' ADDS a permission the member's roles don't give them.
--   • effect='deny'  REMOVES a permission their roles otherwise would.
-- DENY beats GRANT and beats the role layer. The engine
-- (apps/api/src/common/authz/permission.service.ts) resolves the final set as:
--   final = (role-derived ∪ GRANT overrides) − DENY overrides.
--
-- Keyed by user_id (NOT membership_id) so it composes directly with the engine,
-- which resolves the actor by user.id. scope_type/scope_id MIRROR
-- role_assignments exactly (org-scope = the org; project-scope = one project),
-- so an override is as narrowly scopable as a role grant. `permission` is a
-- catalog string (free text, validated in CODE — permissions.ts), exactly like
-- role_permissions / role_assignments.
--
-- This is a literal mirror of the Drizzle schema source of truth
-- (packages/db/src/schema/iam.ts — memberPermissionOverrides). Hand-authored
-- (drizzle-kit is unusable here — see packages/db/CLAUDE.md); a
-- meta/_journal.json entry (idx 61) is added in the same commit.
--
-- NOT applied to shared dev. Gate-6 → HELD for owner.

-- ════════════════════ table ═══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS member_permission_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  text NOT NULL,
  effect      text NOT NULL,
  scope_type  text NOT NULL,
  scope_id    uuid NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- effect ∈ {'grant','deny'}.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'member_permission_overrides_effect_valid'
      AND conrelid = 'member_permission_overrides'::regclass
  ) THEN
    ALTER TABLE member_permission_overrides
      ADD CONSTRAINT member_permission_overrides_effect_valid
      CHECK (effect IN ('grant','deny'));
  END IF;
END;
$$;

-- scope_type ∈ {'org','project'}.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'member_permission_overrides_scope_type_valid'
      AND conrelid = 'member_permission_overrides'::regclass
  ) THEN
    ALTER TABLE member_permission_overrides
      ADD CONSTRAINT member_permission_overrides_scope_type_valid
      CHECK (scope_type IN ('org','project'));
  END IF;
END;
$$;

-- At most ONE override per (user, permission, scope) — a grant + a deny for the
-- same target can never both exist (deny-wins is the engine's tiebreak should a
-- stale pair ever appear).
CREATE UNIQUE INDEX IF NOT EXISTS member_permission_overrides_unique
  ON member_permission_overrides (user_id, permission, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_member_permission_overrides_user
  ON member_permission_overrides (user_id);
CREATE INDEX IF NOT EXISTS idx_member_permission_overrides_scope
  ON member_permission_overrides (scope_type, scope_id);

-- ════════════════════ RLS ═════════════════════════════════════════════════
-- Mirrors role_assignments (migration 0043). An override belongs to a tenant
-- via its scope: org-scope rows match the current org directly; project-scope
-- rows match when the project is in the current org. FORCE so even the table
-- owner is constrained. WITH CHECK prevents writing a row outside the org.
ALTER TABLE member_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_permission_overrides FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='member_permission_overrides'
      AND policyname='tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON member_permission_overrides
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
-- app_user: full DML (RLS scopes the rows to the current org). ALTER DEFAULT
-- PRIVILEGES from 0009 already covers new tables; assert explicitly for clarity
-- + idempotency.
GRANT SELECT, INSERT, UPDATE, DELETE ON member_permission_overrides TO app_user;
