-- 0014: bring audit_log to the locked spec (doc 04c §4, security playbook §12.4)
--
-- As-built audit_log diverged from spec: it used actor_user_id + actor_contractor_id,
-- entity_type/entity_id, before/after, nullable org_id (FK set null), and was
-- missing actor_type/actor_email/ip/user_agent/session_id and the actor_type CHECK.
--
-- Spec model: single actor_id (→users, null = system), actor_type discriminator
-- (CHECK user|system|provider), denormalized actor_email, target_table/target_id,
-- before_state/after_state, forensic ip/user_agent/session_id, org_id NOT NULL +
-- ON DELETE RESTRICT, spec index names.
--
-- All steps are idempotent (guarded) so concurrent test-worker migrate() is safe.

-- ── 1. column renames (guarded) ───────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='audit_log' AND column_name='actor_user_id') THEN
    ALTER TABLE audit_log RENAME COLUMN actor_user_id TO actor_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='audit_log' AND column_name='entity_type') THEN
    ALTER TABLE audit_log RENAME COLUMN entity_type TO target_table;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='audit_log' AND column_name='entity_id') THEN
    ALTER TABLE audit_log RENAME COLUMN entity_id TO target_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='audit_log' AND column_name='before') THEN
    ALTER TABLE audit_log RENAME COLUMN "before" TO before_state;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='audit_log' AND column_name='after') THEN
    ALTER TABLE audit_log RENAME COLUMN "after" TO after_state;
  END IF;
END;
$$;

-- ── 2. drop contractor-actor column (spec model is user|system|provider) ──────
ALTER TABLE audit_log DROP COLUMN IF EXISTS actor_contractor_id;

-- ── 3. add spec columns ───────────────────────────────────────────────────────
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_email text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip inet;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS session_id uuid;

-- ── 4. actor_type NOT NULL — added via column DEFAULT, NOT an UPDATE.
-- audit_log has a BEFORE UPDATE OR DELETE immutable trigger; a backfill UPDATE
-- would be blocked. ADD COLUMN ... NOT NULL DEFAULT back-fills existing rows
-- atomically without a row UPDATE; we then drop the default so new inserts
-- must supply actor_type explicitly (spec §12.4: no default).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_log' AND column_name = 'actor_type'
  ) THEN
    ALTER TABLE audit_log ADD COLUMN actor_type text NOT NULL DEFAULT 'system';
    ALTER TABLE audit_log ALTER COLUMN actor_type DROP DEFAULT;
  END IF;
END;
$$;

-- ── 5. actor_type CHECK ───────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_log_actor_type_valid'
      AND conrelid = 'audit_log'::regclass
  ) THEN
    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_actor_type_valid
      CHECK (actor_type IN ('user','system','provider'));
  END IF;
END;
$$;

-- ── 6. org_id NOT NULL + FK ON DELETE RESTRICT (spec) ────────────────────────
ALTER TABLE audit_log ALTER COLUMN org_id SET NOT NULL;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute a
      ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'audit_log'::regclass
      AND con.contype = 'f'
      AND a.attname = 'org_id'
  LOOP
    EXECUTE format('ALTER TABLE audit_log DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_log_org_id_organizations_id_fk'
      AND conrelid = 'audit_log'::regclass
  ) THEN
    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

-- ── 7. spec-named indexes ─────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_audit_log_org_created;
DROP INDEX IF EXISTS idx_audit_log_entity;
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log (target_table, target_id);
