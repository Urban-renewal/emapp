-- 0021: signature_requests table — Phase 5 public-link signing flow
--
-- Spec: docs/03 §9 (MVP roadmap Phase 5).
-- D.12 LAW: signatures themselves are SVG, encrypted, inline — already in
-- the existing `signatures` table (migration 0015). This migration adds
-- ONLY the request/state table that drives the public-link flow.
--
-- Lifecycle (state machine):
--   pending  ──sign───►  signed       (set signed_at + signed_signature_id)
--           ─cancel──►  cancelled    (set cancelled_at + cancelled_by)
--   pending  ──expiry─►  pending      (expires_at < now() — enforced at
--                                       JWT verify; DB row stays 'pending'
--                                       for the audit trail)
--
-- Single-use guard: the atomic UPDATE
--   UPDATE signature_requests
--   SET status='signed', signed_at=now()
--   WHERE jti=$1 AND status='pending'
--   RETURNING id
-- 0 rows returned ⇒ the token was already consumed or cancelled ⇒ the
-- public sign endpoint returns 401 invalid_token (no oracle distinguishes
-- "never existed" / "expired" / "already signed" / "cancelled").
--
-- RLS: org_id direct-scoped, same pattern as documents / signatures.
-- The public sign endpoint extracts org_id from the verified JWT and
-- runs every read/write through withTenant(orgId) — so RLS still applies
-- on the public path. No BYPASSRLS path is introduced.
--
-- All steps idempotent (guards) so concurrent test-worker migrate() is safe.

-- ════════════════════ table ═════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS signature_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  document_id          uuid NOT NULL REFERENCES documents(id)     ON DELETE RESTRICT,
  owner_id             uuid NOT NULL REFERENCES owners(id)        ON DELETE RESTRICT,
  -- jti: JWT id claim. UNIQUE because that's the single-use guard's key.
  jti                  text NOT NULL,
  status               text NOT NULL DEFAULT 'pending',
  expires_at           timestamptz NOT NULL,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  signed_at            timestamptz,
  -- signed_signature_id is set in the same withTenant tx as the
  -- INSERT INTO signatures. Nullable because it doesn't exist until signed.
  signed_signature_id  uuid REFERENCES signatures(id) ON DELETE RESTRICT,
  cancelled_at         timestamptz,
  cancelled_by         uuid REFERENCES users(id)
);

-- status CHECK — fail-closed enum at the DB level (matches D.18 stance:
-- enums via CHECK + text for forward compatibility, not pg ENUM types).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signature_requests_status_valid'
      AND conrelid = 'signature_requests'::regclass
  ) THEN
    ALTER TABLE signature_requests
      ADD CONSTRAINT signature_requests_status_valid
      CHECK (status IN ('pending','signed','cancelled'));
  END IF;
END;
$$;

-- ════════════════════ indexes ═══════════════════════════════════════════════

-- UNIQUE on jti — supports the atomic single-use UPDATE lookup
CREATE UNIQUE INDEX IF NOT EXISTS signature_requests_jti_unique
  ON signature_requests (jti);

-- Manager list: org + status filter + recent-first
CREATE INDEX IF NOT EXISTS idx_signature_requests_org_status_created
  ON signature_requests (org_id, status, created_at DESC);

-- "is this document already requested/signed?" lookup
CREATE INDEX IF NOT EXISTS idx_signature_requests_doc_status
  ON signature_requests (document_id, status);

-- "what's pending for this owner?" lookup
CREATE INDEX IF NOT EXISTS idx_signature_requests_owner_status
  ON signature_requests (owner_id, status);

-- ════════════════════ RLS ═══════════════════════════════════════════════════
-- Same pattern as documents / signatures (migration 0004).

ALTER TABLE signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_requests FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'signature_requests'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON signature_requests
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ════════════════════ grants ════════════════════════════════════════════════
-- ALTER DEFAULT PRIVILEGES (0009) would auto-grant, but only when the
-- creating role matches. Explicit GRANT here is the belt-and-suspenders
-- guarantee a new table is reachable from withTenant (app_user role).

GRANT SELECT, INSERT, UPDATE ON signature_requests TO app_user;
-- No DELETE to app_user: signed requests are forensic evidence; cancellation
-- is a status transition, not a row delete. (Manager-side "delete" in the
-- API is a status='cancelled' transition.)
