-- 0070: PII step-up unlock + sensitive-document flag — Slice 7b-OTP
-- (docs/DESIGN-phase5-tabu-extraction.md D-P5.5 / D-P5.7 / D-P5.8).
--
-- This migration:
--   1. documents.sensitive — boolean NOT NULL DEFAULT false. A sensitive doc
--      (id_document / financial by type, a tabu נסח source, or an explicit
--      client opt-in at create) requires a VALID per-session PII unlock
--      (step-up OTP) before its presigned download URL is ever minted.
--      BACKFILL: existing id_document/financial rows become sensitive.
--   2. auth_sessions.pii_unlocked_at — timestamptz NULL. Stamped by a
--      successful step-up OTP verify on the CALLER'S CURRENT session only;
--      valid while pii_unlocked_at + security.piiUnlockTtlMinutes (org
--      settings, default 60) > now(). Once-per-SESSION (D-P5.5): another
--      live session of the same user stays locked.
--   3. step_up_codes — the step-up OTP store. Mirrors otp_codes (0020):
--      auth-infra, NO RLS (the unlock flow is session-keyed, not org-keyed;
--      same posture as auth_sessions/0018). Stores ONLY the HMAC hash of the
--      6-digit code — NEVER plaintext. Single-use (used_at), short expiry,
--      max-5 attempts, 3/15min rate-limit derived from created_at. The code
--      is bound to BOTH the user and the requesting session.
--
-- Reversibility: HIGH. DROP TABLE step_up_codes + the two ALTER ... DROP
-- COLUMN restore the prior state.
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

-- ════════════════════ documents.sensitive ═══════════════════════════════
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;

-- Backfill: PII-bearing types become sensitive (D-P5.7 — the by-type derivation
-- the create path enforces from now on, applied to pre-existing rows).
UPDATE documents SET sensitive = true WHERE type IN ('id_document', 'financial');

-- ════════════════════ auth_sessions.pii_unlocked_at ═════════════════════
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS pii_unlocked_at timestamptz;

-- ════════════════════ step_up_codes ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS step_up_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The session the unlock is requested FOR (the code only ever stamps THIS
  -- session). CASCADE: a code is meaningless once its session row is gone.
  session_id  uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  -- HMAC hash of the 6-digit code (hashField, PII_HASH_KEY) — NEVER plaintext.
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_step_up_codes_user_created
  ON step_up_codes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_step_up_codes_session_created
  ON step_up_codes (session_id, created_at DESC);

DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE step_up_codes TO app_user';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
