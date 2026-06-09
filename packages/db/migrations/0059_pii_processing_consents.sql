-- 0059 — P0.C2: pii_processing_consents (privacy-notice acknowledgment trail).
--
-- Israeli Privacy Protection Law requires a recorded lawful basis / notice for
-- processing a resident's (apartment owner's) PII. This table is the immutable
-- per-resident EVIDENCE that the owner was shown — and acknowledged — the org's
-- configurable PII-processing privacy notice at a point in time.
--
-- DISTINCT from D.57 "valid-consent" (the SIGNATURE-threshold % of owners,
-- projects.target_signature_pct). That is a project-level signature target;
-- THIS is the privacy-law processing notice. Keep them separate.
--
-- The notice TEXT is configurable per-org via OrgSettings `privacy` namespace
-- (organizations.settings jsonb — no hardcoded legal copy, no migration). This
-- row pins the exact `notice_version` shown PLUS a `notice_hash` (SHA-256 hex of
-- the precise text the resident saw) so the record self-verifies even if the org
-- later edits its notice copy. No new PII beyond the owner ref + request
-- provenance (IP/UA), mirroring `signatures`.
--
-- APPEND-ONLY / IMMUTABLE: app_user gets INSERT + SELECT only. The
-- ALTER DEFAULT PRIVILEGES in 0009 auto-grants SELECT/INSERT/UPDATE/DELETE to
-- app_user on new public tables, so we REVOKE UPDATE/DELETE here — a consent,
-- once given, is never mutated or deleted (forensic compliance record). Same
-- "no DELETE" posture as audit_log.
--
-- Org-scoped: FORCE RLS `tenant_isolation` on org_id, mirroring owners /
-- signatures / otp_codes (0004 / 0050). Every write goes through
-- withTenant(orgId, …); the consent is written in the SAME tx as the signature
-- (atomic).

CREATE TABLE IF NOT EXISTS pii_processing_consents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_id            uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  notice_version      text NOT NULL,
  notice_hash         text NOT NULL,
  method              text NOT NULL,
  consent_ip          inet,
  consent_user_agent  text,
  acknowledged_at     timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pii_consents_org_owner
  ON pii_processing_consents (org_id, owner_id);

CREATE INDEX IF NOT EXISTS idx_pii_consents_owner_ack
  ON pii_processing_consents (owner_id, acknowledged_at DESC);

-- FORCE RLS — app_user (the withTenant role) is scoped to its own org. The
-- guarded CREATE POLICY matches the repo convention (CREATE POLICY has no
-- IF NOT EXISTS, so a partial-replay would otherwise error).
ALTER TABLE pii_processing_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_processing_consents FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pii_processing_consents'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON pii_processing_consents
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- Append-only grant. The 0009 default privileges would grant full DML; assert
-- the exact privileges we want, then strip mutation/deletion so the row is
-- immutable once written.
DO $$ BEGIN
  EXECUTE 'GRANT INSERT, SELECT ON TABLE pii_processing_consents TO app_user';
  EXECUTE 'REVOKE UPDATE, DELETE ON TABLE pii_processing_consents FROM app_user';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
