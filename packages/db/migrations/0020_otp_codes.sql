-- 0020 (D.20 / GATE 4): Tenant SMS OTP store.
-- Auth-infra, NO RLS (looked up pre-auth by phone hash). Stores only HMAC
-- hashes of the phone and the 6-digit code — never plaintext. Single-use
-- (used_at), 5-min expiry, max-5 attempts, 3/15min rate-limit derived from
-- created_at. Real Israeli SMS provider is a later Infisical config swap
-- behind ISMSProvider (NoopSMSProvider until then).
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

CREATE TABLE IF NOT EXISTS otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash  text NOT NULL,
  code_hash   text NOT NULL,
  owner_id    uuid REFERENCES owners(id) ON DELETE CASCADE,
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_phone_created ON otp_codes (phone_hash, created_at DESC);

DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE otp_codes TO app_user';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
