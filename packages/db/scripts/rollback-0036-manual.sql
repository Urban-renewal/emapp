-- Manual rollback proof for migration 0036 (V11 B.S5). NOT applied by
-- drizzle (forward-only journal). Run via:
--   infisical run --env=dev -- psql "$DATABASE_URL" -f packages/db/scripts/rollback-0036-manual.sql
-- Then delete the idx-36 entry from packages/db/migrations/meta/_journal.json
-- and the corresponding row from drizzle.__drizzle_migrations, then
-- re-run `pnpm db:migrate` to verify the migration re-applies cleanly.

BEGIN;

DROP TABLE IF EXISTS task_external_attendees;

DROP INDEX IF EXISTS idx_tasks_org_scheduled;

ALTER TABLE tasks
  DROP COLUMN IF EXISTS location,
  DROP COLUMN IF EXISTS scheduled_at;

COMMIT;
