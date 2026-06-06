-- 0048: import preview→confirm — add 'awaiting_confirm' status + flags
--
-- Owner directive: a bad Excel must not silently poison the org. An import
-- flagged `require_confirm` runs through parse+validate but PAUSES at a new
-- terminal-for-this-attempt state 'awaiting_confirm' WITHOUT persisting any
-- domain rows. The manager reviews the computed inventory (ok/failed counts +
-- validation errors) and then either confirms (a full fresh re-run that
-- persists for real) or cancels (discard + purge). This mirrors the existing
-- 'awaiting_mapping' stop-and-resume seam (migration 0027) — lower risk than a
-- mid-pipeline resume: on confirm the job re-runs from 'queued', reusing the
-- well-tested full pipeline (no cache-rebuild surgery).
--
--   require_confirm = TRUE  → after validate, pause at awaiting_confirm.
--   confirmed_at IS NULL    → still pending; set by POST /imports/:id/confirm,
--                             which then re-queues at 'queued' (full re-run
--                             that persists, since confirmed_at is now set).
--
-- This migration JUST widens the CHECK + adds the two columns. The worker
-- transition + the confirm endpoint land in their own commits.
-- Forward-only; pre-merge so no production rows exist with the new state.

DO $$
BEGIN
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
      'awaiting_mapping',
      -- 0048: preview pause — validated, inventory computed, NOT persisted;
      -- waiting for the manager to confirm or cancel.
      'awaiting_confirm'
    ));
END;
$$;

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS require_confirm boolean NOT NULL DEFAULT false;

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
