-- 0037: perf indexes for tasks + memberships ORDER BY created_at
--
-- 2026-05-27 Manager-BE perf audit findings:
--   - M1 (perf): GET /api/v1/tasks lists with ORDER BY created_at DESC
--     but no `(org_id, created_at)` index. At 100K tasks across all
--     orgs, the planner falls back to in-RAM sort under RLS — 300-500ms.
--   - M5 (perf): GET /api/v1/members lists with ORDER BY created_at DESC
--     on memberships. No matching index. At 500 members per org, sort
--     dominates the query (~300ms).
--
-- Both are partial indexes (rows where the soft-delete column is NULL)
-- to keep the index small and align with the actual query predicates.
-- Manager-dashboard fan-out can stack these on the 1s budget; closing
-- them takes both from sort-bound to index-scan.
--
-- Reversibility: pure DROP INDEX. Both indexes are additive — no
-- existing query relies on them; the planner just gets a faster path.

-- M1 — tasks list (Manager dashboard "recent tasks" + the WeekCalendar
-- fallback path when scheduled_at filtering is off).
CREATE INDEX IF NOT EXISTS idx_tasks_org_created
  ON tasks (org_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

-- M5 — memberships list under the Members admin page. created_at DESC
-- mirrors the existing ListMembersQuery defaults.
CREATE INDEX IF NOT EXISTS idx_memberships_org_created
  ON memberships (org_id, created_at DESC, id DESC)
  WHERE revoked_at IS NULL;
