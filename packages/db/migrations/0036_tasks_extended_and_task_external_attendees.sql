-- 0036: tasks extended (scheduled_at + location) + task_external_attendees
--
-- V11 Track B.S5 — D.38 calendar groundwork.
--
-- Why
-- ────
-- D.38 promotes Calendar from Phase 2 to MVP. The Manager creates
-- tasks with scheduled day/hour/duration, picks attendees (manager +
-- agent + tenants/owners when relevant), and the BE emails an
-- RFC 5545 .ics attachment to each attendee. WeekCalendar UI on
-- ManagerHome consumes the same `tasks` rows for the visual grid.
--
-- What this migration adds (additive only)
-- ────────────────────────────────────────
-- 1. ALTER TABLE tasks ADD `scheduled_at` (timestamptz, nullable).
--    Distinct from the existing `due_at` column: `due_at` is the
--    soft deadline a task should be completed by (any time on the
--    day); `scheduled_at` is the calendar EVENT start time (a
--    specific moment, drives the ICS DTSTART and the WeekCalendar
--    cell position). Both can be set or null independently.
--
-- 2. ALTER TABLE tasks ADD `location` (text, nullable). Optional
--    human-readable LOCATION field for the ICS event (e.g., "תל
--    אביב, רחוב הירקון 12, קומה 3"). Free text, no structured
--    address — the BE doesn't geocode.
--
-- 3. REUSED existing `tasks.type` column (text, default 'general').
--    Per user direction at B.S1 GO answer Q2: tighten to closed
--    enum (`meeting | field | office | call`) at the Zod boundary,
--    NOT at the DB. Existing legacy 'general' rows stay untouched;
--    new writes are constrained by `CreateTaskInput` / future
--    `UpdateTaskInput`.
--
-- 4. NEW TABLE `task_external_attendees`.
--    Per D.41 (authorized inline by user at B.S1 GO answer Q3):
--    a separate table from the existing `task_assignees`, with
--    DIFFERENT semantics:
--      - task_assignees     = internal users who DO the task
--                             (Manager / Agent — link to `users`)
--      - task_external_attendees = owners/tenants INVITED to the ICS
--                             (link to `owners` — Tier 2 external)
--    Semantic split + foreign-tier link justifies separate tables;
--    polymorphic FK or shared assignee table would conflate
--    "actor" and "invitee" and lose the tier audit trail.
--
--    Idempotency-aware columns:
--      ics_sent_at      — last successful ICS send (RFC 5545 METHOD:REQUEST)
--      ics_cancelled_at — last cancellation (RFC 5545 METHOD:CANCEL)
--    Used by B.S7 (Resend integration) to avoid double-sending if
--    the BE crashes between send and audit-log, and to track per-
--    attendee delivery status for the future audit view.
--
-- RLS template
-- ────────────
-- Template B — via parent, per D.24 + 0011 revert. The chain is:
--   task_external_attendees.task_id → tasks.org_id → app.organization_id GUC
-- tasks already has org_id direct (it's an org-level table, same as
-- mapping_templates / signature_requests), so this is a single-hop
-- via-parent chain. Same pattern as task_assignees (which has
-- task_id FK and no org_id direct).
--
-- GRANT
-- ─────
-- SELECT + INSERT + UPDATE on app_user. NO DELETE — soft-delete
-- semantics via ics_cancelled_at + (future) archived_at on tasks.
-- Matches the forensic posture of mapping_templates / import_jobs.
--
-- Reversibility
-- ─────────────
-- HIGH. Manual rollback in PR description:
--   DROP TABLE task_external_attendees;
--   ALTER TABLE tasks DROP COLUMN scheduled_at, DROP COLUMN location;
-- (Plus delete the journal entry for idx 36.) Additive only — no
-- data migration, existing tasks rows unaffected.

-- ════════════════════ tasks — D.38 additive columns ═════════════════
--
-- IF NOT EXISTS guards because drizzle migrations rerun-on-startup
-- in dev (against the same DB across worktrees) and we don't want
-- the second run to fail.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS location text;

-- Hot lookup: "tasks scheduled in this org between dates" (calendar
-- week-of-X queries from WeekCalendar). Partial: only future +
-- non-archived. created_at not used here — the calendar is keyed
-- on scheduled_at.
CREATE INDEX IF NOT EXISTS idx_tasks_org_scheduled
  ON tasks (org_id, scheduled_at)
  WHERE archived_at IS NULL AND scheduled_at IS NOT NULL;

-- ════════════════════ task_external_attendees (D.41) ════════════════
CREATE TABLE IF NOT EXISTS task_external_attendees (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,

  -- Tier-2 external invitee. ON DELETE RESTRICT because losing an
  -- attendee row when an owner is hard-deleted would erase the
  -- audit trail of "we sent X person an ICS for Y task". Owners are
  -- soft-deleted in practice (archived_at), so this is a defence-
  -- in-depth posture, not an active blocker.
  owner_id           uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,

  -- Idempotency / audit trail for the ICS pipeline (B.S7).
  -- Nullable because the row may exist before the first send (e.g.,
  -- task created → attendees attached → batch send job picks them
  -- up). Each successful send/cancel updates the timestamp.
  ics_sent_at        timestamptz,
  ics_cancelled_at   timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now()
);

-- An owner can be invited to a task ONCE. Multiple rows for the
-- same (task, owner) pair would yield duplicate ICS sends.
CREATE UNIQUE INDEX IF NOT EXISTS task_external_attendees_task_owner_unique
  ON task_external_attendees (task_id, owner_id);

-- Reverse lookup: "all tasks this owner is invited to" (for the
-- B.S4 portal — `GET /portal/signatures` analogue could surface
-- upcoming calendar events for a tenant later).
CREATE INDEX IF NOT EXISTS idx_task_external_attendees_owner
  ON task_external_attendees (owner_id);

-- ─── RLS (Template B — via parent task → org GUC) ───────────────────
ALTER TABLE task_external_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_external_attendees FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'task_external_attendees'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON task_external_attendees
      USING (
        task_id IN (
          SELECT id FROM tasks
          WHERE org_id = current_setting('app.organization_id', true)::uuid
        )
      )
      WITH CHECK (
        task_id IN (
          SELECT id FROM tasks
          WHERE org_id = current_setting('app.organization_id', true)::uuid
        )
      );
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; idempotency-aware soft-cancel via ics_cancelled_at) ───
GRANT SELECT, INSERT, UPDATE ON task_external_attendees TO app_user;
REVOKE DELETE ON task_external_attendees FROM app_user;
