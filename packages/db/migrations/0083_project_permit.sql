-- 0083: building-permit (היתר בנייה) tracking on projects — wave-2.4 future-states,
-- permit-only first cut (objections / financing / hold are separate later slices).
--
-- WHY: an urban-renewal project must obtain a building permit (היתר בנייה); the
-- permit has its own lifecycle (applied → approved) and, critically, an EXPIRY —
-- an approved permit that lapses before construction starts is real, costly work
-- the manager must chase. Today nothing in the model tracks the permit state or
-- its expiry, so the situation-picture cannot surface "היתר עומד לפוג". This adds
-- the minimal permit fields + a NEW closed enum for the permit state.
--
-- LOCKED-ENUM SAFETY: this does NOT touch the D.18 `project_status` enum. The
-- permit lifecycle is an ORTHOGONAL, ADDITIVE axis (`permit_status`) — a project
-- in any non-terminal status may carry any permit_status. We deliberately model
-- it as its own enum, never as new project_status values.
--
-- ADDITIVE + BACKWARD-COMPATIBLE: `permit_status` defaults to 'none' (every
-- existing row reads back 'none' — i.e. no permit tracked yet); the two
-- timestamps are nullable with no default. Zero breakage to existing rows or the
-- create/update flow.
--
-- NO PII: permit_status is an enum discriminator; the two timestamps are dates.
-- None of the three columns carry owner national_id/phone/name or any PII.
--
-- RLS: unchanged. `projects` already has FORCE ROW LEVEL SECURITY + the
-- tenant_isolation policy (org_id GUC); new columns inherit it automatically —
-- no new policy needed.
--
-- Reversibility: HIGH. DROP the three columns + DROP TYPE permit_status restores
-- the prior shape with no data loss for existing rows (they carried no permit
-- data). See the down-migration note at the foot of this file.

-- The closed permit lifecycle. `applied` = a permit application is in process;
-- `approved` = granted (then `permit_expiry_at` is meaningful); `rejected` =
-- refused; `expired` = an approved permit lapsed. `none` = nothing tracked yet
-- (the default for every existing + future-untracked project).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'permit_status') THEN
    CREATE TYPE permit_status AS ENUM ('none', 'applied', 'approved', 'rejected', 'expired');
  END IF;
END;
$$;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS permit_status permit_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS permit_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS permit_expiry_at timestamptz;

-- The autonomy `permit-expiring` recommender scans, set-based, for non-terminal,
-- non-archived projects whose permit_expiry_at falls within the warning window.
-- A partial index on the expiry of approved permits keeps that scan index-backed
-- as the fleet scales (the recommender filters status NOT IN terminal + archived
-- at NULL; the common predicate is "has an approved permit with an expiry").
CREATE INDEX IF NOT EXISTS idx_projects_permit_expiry
  ON projects (permit_expiry_at)
  WHERE permit_status = 'approved'
    AND permit_expiry_at IS NOT NULL
    AND archived_at IS NULL;

-- ── Down (manual, for review — additive + reversible) ───────────────────────
-- DROP INDEX IF EXISTS idx_projects_permit_expiry;
-- ALTER TABLE projects
--   DROP COLUMN IF EXISTS permit_expiry_at,
--   DROP COLUMN IF EXISTS permit_applied_at,
--   DROP COLUMN IF EXISTS permit_status;
-- DROP TYPE IF EXISTS permit_status;
