-- 0025: UNIQUE (job_id, row_number, code) on import_job_errors
--
-- Audit-pass v2 finding C9 (MEDIUM). The handler's validateStage
-- batched-INSERTs per-row errors into import_job_errors inside a
-- single withTenant tx. If pg-boss retries the job mid-validate
-- (worker died, timeout, network blip), the retry re-downloads the
-- file, re-parses, re-validates the same rows, and re-INSERTs the
-- same errors — duplicating every row. The schema had no UNIQUE to
-- prevent it.
--
-- The handler comment in import-job.handler.ts:28-31 (S2) PROMISED
-- "forensic uniqueness" in the audit row sense; this migration makes
-- the import_job_errors table back that promise structurally.
--
-- Why (job_id, row_number, code) and not just (job_id, row_number):
--   A single row in the source Excel can have multiple independent
--   failures — e.g. a row with both `invalid_luhn` (national_id) and
--   `invalid_phone` produces TWO error entries with the same
--   row_number but different `code`. The composite (job_id,
--   row_number, code) preserves this multiplicity while preventing
--   exact duplicates on retry.
--
-- Forward-only; no production data ever held duplicate rows (no
-- production import has run yet — Phase 6 is pre-merge).
--
-- Idempotent — CREATE UNIQUE INDEX IF NOT EXISTS is a no-op if the
-- index already exists.

CREATE UNIQUE INDEX IF NOT EXISTS import_job_errors_unique
  ON import_job_errors (job_id, row_number, code);
