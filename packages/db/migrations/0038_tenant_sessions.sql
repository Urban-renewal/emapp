-- 0038 (Wave 4 M-1): tenant_sessions — domain-owned session store for the
-- Tenant Portal tier (D.40). Mirrors `auth_sessions` (migration 0018,
-- D.21) for the org tier: auth infrastructure (NO RLS — looked up
-- pre-auth by session id, before app.organization_id exists in the
-- pool's GUC).
--
-- Closes the "30-min unrevocable JWT" hole: today `POST /auth/otp/verify`
-- mints a 30-min `emapp-tenant` JWT with no `sid` claim and no DB row →
-- a stolen phone has full portal access until expiry. With this table:
--   * verify inserts a row, mints JWT with `sid` claim.
--   * TenantAuthGuard checks `isTenantSessionActive(sid)` (cached 15s
--     same as org pattern) → revoke takes ≤15s instead of ≤30min.
--   * `POST /portal/logout` sets revoked_at → immediate kill.
--
-- The interim TTL drop (30→10 min, in otp.service.ts) is a separate
-- one-line change in the same PR; the table is the structural fix.
--
-- Why NO RLS (deviates from "Template A direct org_id" in the audit):
-- this is auth infrastructure, not domain data. The lookup happens BEFORE
-- the guard sets app.organization_id (we don't know the org yet — that's
-- what the JWT claim TELLS us). Matches `auth_sessions` exactly. The
-- token-fork attack (forge JWT with another org's sid) is blocked by
-- the JWT signature, not by RLS.
--
-- Soft delete via `revoked_at`. NO DELETE GRANT (matches CLAUDE.md hard
-- rule: soft delete only; audit trail preserved).

CREATE TABLE IF NOT EXISTS tenant_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  ip          text,
  user_agent  text
);

CREATE INDEX IF NOT EXISTS idx_tenant_sessions_owner ON tenant_sessions (owner_id);
-- Partial index for the "active tenant sessions per org" admin view
-- (Provider-Admin revoke endpoint is deferred per wave4 audit, but the
-- index is cheap and the query shape is fixed).
CREATE INDEX IF NOT EXISTS idx_tenant_sessions_org_active
  ON tenant_sessions (org_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- Pre-auth lookup uses the BYPASSRLS pool (matches auth_sessions in 0018);
-- still GRANT to app_user for defence-in-depth + future tenant-scoped
-- reads (e.g. "list my own active sessions"). NO DELETE — soft revoke
-- only via revoked_at update.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE tenant_sessions TO app_user';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
