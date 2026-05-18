-- 0018 (D.21): domain-owned session store + per-account lockout.
-- Replaces the Better Auth ba_session hybrid. auth_sessions is auth
-- infrastructure (no RLS): looked up pre-auth by token hash. Stores only a
-- SHA-256 hash of the opaque refresh token — never the raw token.
-- All steps guarded/idempotent so concurrent test-worker migrate() is safe.

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  replaced_by uuid,
  ip          text,
  user_agent  text
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);

-- auth_sessions is owner-accessed (no RLS, like the retired ba_session).
-- Grant the restricted app_user role too so a future withTenant path can
-- read its own sessions if needed (defence-in-depth, parity with 0009).
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_sessions TO app_user';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
