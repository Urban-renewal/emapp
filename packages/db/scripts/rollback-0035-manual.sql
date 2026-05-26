-- Manual rollback proof for migration 0035 (V11 B.S1). NOT committed
-- to migrations/. Run via:
--   infisical run --env=dev -- psql "$DATABASE_URL" -f packages/db/scripts/rollback-0035-manual.sql
-- Then delete the idx-35 entry in packages/db/migrations/meta/_journal.json
-- and re-run pnpm db:migrate to verify 0035 re-applies cleanly.

BEGIN;

DROP TABLE IF EXISTS building_sections;

ALTER TABLE apartments
  DROP COLUMN IF EXISTS entrance,
  DROP COLUMN IF EXISTS area_sqm,
  DROP COLUMN IF EXISTS unit_type;

COMMIT;
