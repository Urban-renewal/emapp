-- 0027: add 'awaiting_mapping' to import_jobs.status CHECK
--
-- Phase 6 S7 — layered mapping seam (D.34).
--
-- Today's parseStage runs `resolveMapping(headers)` (the deterministic
-- alias registry — Layer 1 of D.34). When the file's headers can't be
-- matched, the handler USED TO throw NonRetryableJobError and the row
-- went to 'failed'. That was wrong: every customer with a non-standard
-- column-naming convention got rejected forever.
--
-- The new design (D.34): on a Layer-1 miss, the worker transitions the
-- row to a NEW terminal-for-this-attempt state — 'awaiting_mapping' —
-- and stops cleanly. The wizard (S8) or the agent normalisation layer
-- (Phase 7+) then resolves the mapping out-of-band and re-enqueues the
-- job at status='validating' with `mapping_template_id` set.
--
-- This migration JUST widens the CHECK constraint. The handler-side
-- transition + the wizard endpoint that unblocks the row + the
-- mapping_templates table all land in their own migrations / commits.
--
-- Forward-only; pre-merge so no production rows exist with the new
-- state. Safe.

DO $$
BEGIN
  -- Drop the existing constraint (PG doesn't support ALTER CHECK).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'import_jobs_status_valid'
      AND conrelid = 'import_jobs'::regclass
  ) THEN
    ALTER TABLE import_jobs DROP CONSTRAINT import_jobs_status_valid;
  END IF;

  ALTER TABLE import_jobs
    ADD CONSTRAINT import_jobs_status_valid
    CHECK (status IN (
      'queued', 'parsing', 'validating', 'persisting',
      'done', 'failed', 'cancelled',
      -- Phase 6 S7 addition: file parsed OK but headers couldn't be
      -- mapped to the canonical fields by Layer-1 (alias registry).
      -- Manual mapping (wizard, S8) or agent (Phase 7+) provides the
      -- mapping_template_id and re-queues at 'validating'.
      'awaiting_mapping'
    ));
END;
$$;
