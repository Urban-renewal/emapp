-- v8 §v8-S1 — R2 object retention column.
--
-- BACKGROUND
--   Uploaded Excel files (raw PII: national_id, phone, name, address
--   in cleartext) currently live in `org/<id>/import/<uuid>.xlsx`
--   forever — no `storage.delete()` on any terminal state, no R2
--   bucket lifecycle rule. Israeli privacy-law right-to-erasure +
--   ISO A.18.1.4 data-minimisation both fail today.
--
-- THIS MIGRATION
--   Adds `file_deleted_at timestamptz NULL` to `import_jobs`. The
--   worker writes this when it calls `storage.delete(fileR2Key)` at
--   a terminal state (done / failed / cancelled). A pg-boss
--   scheduled sweeper (see `apps/worker/src/handlers/import-bytes-sweeper.handler.ts`)
--   purges old bytes 30 days post-terminal.
--
--   The CHECK constraint enforces "only terminal jobs can have their
--   bytes deleted" — a non-terminal `file_deleted_at` would break
--   the worker's retry path (parseStage would try to download bytes
--   that no longer exist).
--
-- ROLLBACK PLAN
--   `ALTER TABLE import_jobs DROP COLUMN file_deleted_at;` — safe
--   because the worker logic gracefully handles the column being
--   absent (drizzle .select() doesn't error on missing columns at
--   query time — schema mismatch surfaces at typecheck only).
--
-- NB: We do NOT add a defensive `WHERE archived_at IS NULL` clause
--   to the CHECK — archived imports must still be allowed to have
--   their bytes purged (in fact they're prime candidates).

ALTER TABLE import_jobs
  ADD COLUMN file_deleted_at timestamptz NULL;

ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_file_deleted_at_terminal_only
  CHECK (
    file_deleted_at IS NULL
    OR status IN ('done', 'failed', 'cancelled')
  );

-- Forensic index: support "show me all jobs whose bytes have NOT yet
-- been purged but should be" queries. The sweeper uses this every
-- N minutes; without it, a sequential scan of import_jobs across all
-- orgs is expensive at scale.
CREATE INDEX IF NOT EXISTS idx_import_jobs_purge_candidates
  ON import_jobs (finished_at)
  WHERE
    file_deleted_at IS NULL
    AND status IN ('done', 'failed', 'cancelled');
