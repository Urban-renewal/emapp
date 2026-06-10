-- 0055 (P1 R0.1): self-service org password-reset tokens (OWASP Forgot-Password).
--
-- Operational-critical gap closure: a locked-out org Manager/Owner had NO
-- self-service recovery. This table backs `POST /auth/forgot-password` (mint)
-- and `POST /auth/reset-password` (consume).
--
-- Auth INFRASTRUCTURE — NO RLS, exactly like auth_sessions (0018) and the
-- pre-auth login/loadProfile reads (D.21): the reset flow runs PRE-AUTH (the
-- user has no session, no org context). It is read/written ONLY by the raw
-- `db` BYPASSRLS connecting role from the AuthService. There is NO org_id
-- column (a reset is per-USER, not per-org), so there is nothing to scope on;
-- mirroring auth_sessions is the correct posture (not the otp_codes org-scoped
-- posture, which exists only because otp_codes carries an org_id + an app_user
-- grant).
--
-- Stores ONLY the SHA-256 hash of the raw token — never the raw token. A
-- DB/backup leak yields no usable reset links. Single-use (used_at), short
-- expiry (<=30 min, enforced in the service), per-IP/per-email rate-limited at
-- the throttler.
--
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  requested_ip text
);

-- Lookup is by token_hash (reset consume) — UNIQUE both indexes it and makes a
-- hash collision a hard error rather than an ambiguous multi-row match.
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash
  ON password_reset_tokens (token_hash);
-- Per-user reads (rate-limit window count + invalidate-prior-on-new-request).
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens (user_id);

-- password_reset_tokens is owner-accessed (no RLS, like auth_sessions 0018).
-- Grant the restricted app_user role too for parity/defence-in-depth (a future
-- withTenant path could read its own tokens) — matches 0009/0018.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE password_reset_tokens TO app_user';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
