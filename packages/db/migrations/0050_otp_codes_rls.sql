-- 0050 — M1: restore the FORCE-RLS org-scoped invariant on otp_codes.
--
-- otp_codes had an `org_id` column AND a full app_user DML grant (0020) but NO
-- row-level security. app_user is the role `withTenant` drops into (SET LOCAL
-- ROLE app_user); without a policy, any in-`withTenant` query against otp_codes
-- was UNSCOPED — a latent cross-org read of the one customer-adjacent table
-- breaking the FORCE-RLS-everywhere invariant. (Unexploited today: no in-tenant
-- code path queries otp_codes, and the rows are HMAC-only — no cleartext PII.)
--
-- The OTP service (apps/api/.../otp.service.ts) reads/writes otp_codes via the
-- RAW `db` connecting role (e.g. neondb_owner / postgres), which has BYPASSRLS
-- — its pre-auth, cross-org phoneHash lookup is by design and is UNAFFECTED by
-- this policy. This change scopes ONLY app_user (the in-`withTenant` role) to
-- its own org, exactly mirroring owners/ownerships (0004).
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes FORCE ROW LEVEL SECURITY;

-- Guarded CREATE POLICY (idempotent) — matches the repo convention since 0021;
-- CREATE POLICY has no IF NOT EXISTS, so a manual re-apply / partial-failure
-- replay would otherwise error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'otp_codes'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON otp_codes
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;
