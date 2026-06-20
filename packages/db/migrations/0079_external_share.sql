-- 0079: external_share — X-S2 (V13) generalized, party-TYPED external-sharing
-- grant. Supersedes the contractor-only `shares` table by adding a party_type
-- taxonomy + scope_type/scope_ids addressing, so a grant can target a developer
-- / lawyer / bank / supervisor / appraiser / surveyor / committee / special
-- admin over a project, building, or apartment set.
--
-- ADDITIVE: this migration does NOT touch `shares`. The contractor tier keeps
-- running on `shares` + ShareTokenService until a deliberate parity-proven
-- migration (X-S8, Wave D).
--
-- This migration:
--   1. CREATE TYPE external_share_party_type + external_share_scope_type
--      (guarded — idempotent under concurrent test-worker migrate()).
--   2. CREATE TABLE external_share (org_id-scoped; scope_ids uuid[]; jsonb
--      permissions; allow_sensitive + otp_required flags; revoked_at lifecycle).
--   3. RLS — direct org_id policy (documents-style, migration 0004/0073),
--      ENABLE + FORCE. Mirrors parcel_setups (0073) / tabu_extractions (0068).
--   4. GRANTs to app_user (SELECT/INSERT/UPDATE; no DELETE — revoke is a
--      revoked_at status transition, never a hard delete). Mirrors 0073.
--
-- Reversibility: HIGH. DROP TABLE external_share; DROP TYPE
-- external_share_scope_type; DROP TYPE external_share_party_type restores the
-- prior state. Guarded/idempotent so a concurrent test-worker migrate() is safe.

-- ════════════════════ enum types (guarded) ══════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'external_share_party_type') THEN
    CREATE TYPE external_share_party_type AS ENUM (
      'developer',
      'tenant_lawyer',
      'developer_lawyer',
      'bank',
      'supervisor',
      'appraiser',
      'surveyor',
      'committee',
      'special_admin'
    );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'external_share_scope_type') THEN
    CREATE TYPE external_share_scope_type AS ENUM ('project', 'building', 'apartment');
  END IF;
END;
$$;

-- ════════════════════ external_share ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS external_share (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Direct org_id isolation key (documents-style). RLS gates reads/writes by
  -- the app.organization_id GUC below.
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- The KIND of external party. Each value has a server-side preset CEILING
  -- (packages/db/src/schema/external-share.ts) the service narrows from.
  party_type         external_share_party_type NOT NULL,

  -- What scope_ids point AT: whole projects, specific buildings, or apartments.
  scope_type         external_share_scope_type NOT NULL,

  -- The concrete projects/buildings/apartments this grant addresses. The
  -- service validates every id resolves inside the caller's org before insert;
  -- RLS guarantees the row itself is org-isolated.
  scope_ids          uuid[] NOT NULL,

  -- Narrowed-from-ceiling permission grant (strict-Zod ExternalSharePermissions
  -- at the API edge; service re-validates against the party ceiling).
  permissions        jsonb NOT NULL,

  -- Sensitive-byte access (PII / decrypt-stream). Default OFF; only a party
  -- whose ceiling permits sensitive may turn it on (service-enforced).
  allow_sensitive    boolean NOT NULL DEFAULT false,

  -- OTP access flag (X-S4 honors it). Org default-ON; carried here so a
  -- per-share narrow (turning it off) is possible only where the org allows.
  otp_required       boolean NOT NULL DEFAULT true,

  -- TTL. NULL = no expiry (still bounded by the ceiling's maxTtlDays at create).
  expires_at         timestamptz,

  -- Per-recipient watermark subject (X-S5 overlay). Free text, never PII-keyed.
  watermark_subject  text,

  created_by         uuid NOT NULL REFERENCES users(id),

  -- Lifecycle = revoked_at (immediate, no physical delete) + revoked_by.
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES users(id),

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- org list / keyset pagination on active grants.
CREATE INDEX IF NOT EXISTS idx_external_share_org_active
  ON external_share (org_id, created_at DESC, id DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_share_org_party
  ON external_share (org_id, party_type)
  WHERE revoked_at IS NULL;

-- ─── RLS (direct org_id — COPIED from parcel_setups, migration 0073) ─────────
ALTER TABLE external_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_share FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'external_share'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON external_share
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; revoke is a revoked_at transition) ───────
GRANT SELECT, INSERT, UPDATE ON external_share TO app_user;
REVOKE DELETE ON external_share FROM app_user;
