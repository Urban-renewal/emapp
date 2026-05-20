-- 0024: REVOKE DELETE on import_jobs + import_job_errors from app_user
--
-- Phase 6 audit-pass (pre-S2) finding #2: migration 0022 declared
-- `GRANT SELECT, INSERT, UPDATE ON import_jobs TO app_user` intending
-- to DENY delete. BUT migration 0009 set
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public
--    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user`,
-- which gives every new table DELETE by default. The 0022 GRANT only
-- ADDED — it didn't revoke. So `app_user` still had DELETE on these
-- tables, breaking the forensic-evidence guarantee documented in 0022.
--
-- Forensic intent: an import_job is evidence — cancellation is a
-- status transition, not a row delete. Provider-admin can delete via
-- the BYPASSRLS provider pool when truly necessary. The app surface
-- MUST NOT have a DELETE path.
--
-- Pinned by `packages/db/test/import-jobs-schema.spec.ts` test #9
-- (asserts pg code 42501 / permission denied for DELETE under
-- withTenant, which runs as app_user).
--
-- Idempotent — REVOKE on a permission that's already absent is a no-op.

REVOKE DELETE ON import_jobs       FROM app_user;
REVOKE DELETE ON import_job_errors FROM app_user;
