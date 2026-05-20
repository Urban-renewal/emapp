-- 0023: drop `raw_row` from import_job_errors — PII compliance (D.12 + ISO A.9.4)
--
-- Phase 6 audit-pass (pre-S2): migration 0022 stored the raw parsed
-- Excel row in jsonb on import_job_errors. For urban-renewal imports
-- the row contains national_id + phone — the same PII that D.12
-- mandates be pgcrypto-encrypted-at-rest. Storing it unencrypted in
-- `raw_row` violated the locked rule + would have been a CRITICAL
-- finding on the first ISO/SOC2 audit.
--
-- Resolution: drop the column entirely. The manager re-downloads the
-- original Excel from R2 (`import_jobs.file_r2_key`); errors carry just
-- enough to point the manager at "row X, field Y, code Z".
--
-- Forward-only; no production data ever held the column (the parent
-- migration 0022 is still pre-merge as of this audit).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_job_errors'
      AND column_name = 'raw_row'
  ) THEN
    ALTER TABLE import_job_errors DROP COLUMN raw_row;
  END IF;
END;
$$;
