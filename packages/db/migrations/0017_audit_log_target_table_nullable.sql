-- 0017: drop the legacy NOT NULL on audit_log.target_table (spec-alignment).
--
-- Root cause: 0003 created the column as `entity_type text NOT NULL`. 0014
-- renamed entity_type → target_table but a RENAME preserves NOT NULL, and 0014
-- never dropped it. The locked spec / drizzle schema (artifacts.ts) defines
-- target_table as nullable: actions with no target (login, logout) legitimately
-- have target_table = NULL. This brings the DB back in line with the spec.
--
-- DROP NOT NULL is idempotent (no-op if already nullable), so concurrent
-- test-worker migrate() is safe.

ALTER TABLE audit_log ALTER COLUMN target_table DROP NOT NULL;
