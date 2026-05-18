-- 0019 (D.21 / T2.10): Provider-tier session store + lockout parity.
-- provider_sessions mirrors auth_sessions but FKs provider_users (the
-- Provider Admin identity is a separate table from domain users). Auth
-- infra — no RLS (looked up pre-auth by token hash). Stores only the
-- SHA-256 hash of the opaque refresh token. Provider refresh TTL = 4h
-- (Doc07 §6.7), access JWT 30 min, MFA mandatory every login.
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

ALTER TABLE provider_users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE provider_users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

CREATE TABLE IF NOT EXISTS provider_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id uuid NOT NULL REFERENCES provider_users(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  replaced_by      uuid,
  ip               text,
  user_agent       text
);

CREATE INDEX IF NOT EXISTS idx_provider_sessions_user ON provider_sessions (provider_user_id);

-- provider_sessions is owner/provider-role accessed; app_user must NOT see it.
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON TABLE provider_sessions FROM app_user';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE provider_sessions TO provider_app_role';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
