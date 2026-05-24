-- 0026: add project_id to import_jobs (S6 unblock)
--
-- Phase 6 S6 needs to materialise buildings during persistence, and
-- buildings.project_id is NOT NULL. Until now import_jobs carried no
-- way to know which project the materialised buildings should belong
-- to — Lidor's decision A (commit 0b6c019 PROGRESS note): add the
-- column to import_jobs; the wizard FE (S8) supplies it at POST /imports.
--
-- nullable=true with a backfill story:
--   - In production no import_jobs row exists yet (Phase 6 is pre-merge),
--     so the nullable transition is safe.
--   - New rows from S8 onwards MUST set project_id. Enforced at the
--     API layer (Zod schema in the create-import DTO, S8) AND at the
--     worker layer (persistStage refuses to advance without it).
--   - We don't add a NOT NULL constraint here because tests + dev may
--     create import_jobs rows without a project (for the seam where
--     S5 validation runs but persistence is a stub). A future
--     migration MAY tighten to NOT NULL once the S8 endpoint is the
--     only producer.
--
-- ON DELETE RESTRICT — an import_job is forensic evidence; deleting
-- a project that owns one would lose that trail. Operators wanting
-- to delete a project must first archive the import jobs (via the
-- BYPASSRLS provider pool).
--
-- Idempotent — IF NOT EXISTS makes re-running safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_jobs'
      AND column_name = 'project_id'
  ) THEN
    ALTER TABLE import_jobs
      ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE RESTRICT;

    -- Index for the manager UI's "imports filtered by project" query
    -- (S8 list endpoint). Partial — active jobs only, since terminal
    -- jobs rarely need this filter and accumulate over time.
    CREATE INDEX IF NOT EXISTS idx_import_jobs_project_active
      ON import_jobs (project_id)
      WHERE project_id IS NOT NULL
        AND status IN ('queued', 'parsing', 'validating', 'persisting');
  END IF;
END;
$$;
