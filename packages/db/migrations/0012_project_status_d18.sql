-- 0012: align project_status enum with DECISION D.18 (LAW)
--
-- D.18 locks the set to: planning | gathering_signatures | approved |
-- in_construction | completed | cancelled.
-- The enum was created (doc 04c, which itself contradicts D.18) as:
-- planning | gathering_signatures | permits | construction | completed | archived.
--
-- Mapping (RENAME VALUE preserves sort order and existing rows):
--   permits      → approved
--   construction → in_construction
--   archived     → cancelled
--   (planning, gathering_signatures, completed unchanged)
--
-- Each rename is guarded so the migration is idempotent under concurrent
-- migrate() calls from parallel test workers (PG 16, runs inside a tx).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'project_status' AND e.enumlabel = 'permits'
  ) THEN
    ALTER TYPE project_status RENAME VALUE 'permits' TO 'approved';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'project_status' AND e.enumlabel = 'construction'
  ) THEN
    ALTER TYPE project_status RENAME VALUE 'construction' TO 'in_construction';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'project_status' AND e.enumlabel = 'archived'
  ) THEN
    ALTER TYPE project_status RENAME VALUE 'archived' TO 'cancelled';
  END IF;
END;
$$;
