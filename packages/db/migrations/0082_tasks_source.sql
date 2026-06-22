-- 0082: tasks.source + tasks.origin_ref — the SYSTEM-OWNED task discriminator
-- (Autonomous Master Plan, G1 TaskWatcher).
--
-- WHY: G1 turns the passive `tasks` CRUD surface into the system's self-maintained
-- backlog. A manager APPROVES a `task.create` proposal → the engine creates a task
-- via the EXISTING gated `tasks.create` method (verbatim), but it must be marked as
-- SYSTEM-SOURCED so it lives in a separate namespace from a human's tasks (the
-- guardrail: a system reconciler can never silently mutate a human's task, and the
-- future auto-close only flips `source='system'` rows). `origin_ref` carries the
-- producing condition's deterministic dedup key so a condition yields exactly ONE
-- open system task (auto-create dedup) — and the future auto-close can find it.
--
-- ADDITIVE + BACKWARD-COMPATIBLE: both columns are nullable/defaulted. Every
-- existing row + every human-authored future row is `source='user'`, `origin_ref`
-- NULL — the human path is unchanged and the FE DTO (CreateTaskInput) does NOT
-- expose these (they are set only by the gated executor, never by a request body),
-- so the tasks RLS/authorship policy is NOT weakened.
--
-- NO PII: both columns carry only an enum-ish discriminator + an opaque dedup key
-- (e.g. 'task.create:missing-doc:<projectId>:land_registry') — never national_id/
-- phone/name.
--
-- RLS: unchanged. `tasks` is already org-isolated (FORCE RLS on app.organization_id);
-- adding columns does not touch the policy. No new grants.
--
-- Reversibility: HIGH. DROP COLUMN restores the prior shape; no data loss for the
-- existing user-authored rows. Guarded/idempotent for concurrent test-worker migrate().

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS origin_ref text;

-- Pin the discriminator domain so a stray writer can't invent a third source.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_source_valid'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_source_valid CHECK (source IN ('user', 'system'));
  END IF;
END;
$$;

-- The auto-create dedup + future auto-close lookup: at most ONE open (non-archived)
-- system task per origin condition. A partial UNIQUE on system rows only — human
-- tasks (origin_ref NULL) are never constrained. Releases once the system task is
-- archived (soft-deleted), so a condition that recurs after resolution can re-open.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_system_origin_open_unique
  ON tasks (org_id, origin_ref)
  WHERE source = 'system' AND origin_ref IS NOT NULL AND archived_at IS NULL;
