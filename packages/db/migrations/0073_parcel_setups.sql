-- 0073: parcel_setups — P3a "parcel-setup envelope + manual path → skeleton"
-- (docs/DESIGN-phase3-parcel-autosetup.md §1/§4/§6 P3a/§7.1).
--
-- A `parcel_setup` is the PROJECT-attached envelope around a single גוש-חלקה
-- setup run: block+parcel(+sub) in, a draft buildings/apartments jsonb payload
-- (NO PII — enforced by the STRICT Zod schema at the API edge AND in the
-- service), and a draft→confirmed/discarded lifecycle. CONFIRM materializes
-- the physical skeleton (buildings + apartments) atomically with provenance.
-- The payload is PUBLIC-RECORD data (addresses, counts) — no pgcrypto — but
-- org-scoped (FORCE RLS, no-oracle 404), mirroring tabu_extractions (0068).
--
-- This migration:
--   1. CREATE TABLE parcel_setups (org_id-scoped; closed status enum CHECK;
--      project_id → projects — §7.1-4: P3a attaches to an EXISTING project).
--   2. RLS — direct org_id policy (documents-style, migration 0004),
--      ENABLE + FORCE. Mirrors tabu_extractions (0068) exactly.
--   3. GRANTs to app_user (SELECT/INSERT/UPDATE; no DELETE — confirm/discard
--      is a status transition, never a hard delete). Mirrors 0068.
--   4. Provenance: buildings.source_parcel_setup_id uuid NULL REFERENCES
--      parcel_setups(id) (mirror ownerships.source_extraction_id, 0071).
--      Apartments inherit via their building — NO duplicate column.
--
-- Reversibility: HIGH. ALTER TABLE buildings DROP COLUMN
-- source_parcel_setup_id; DROP TABLE parcel_setups restores the prior state.
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

-- ════════════════════ parcel_setups ═════════════════════════════════════════
CREATE TABLE IF NOT EXISTS parcel_setups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Direct org_id isolation key (documents-style). RLS gates reads/writes by
  -- the app.organization_id GUC below.
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- §7.1-4 — P3a attaches the setup to an EXISTING project. ON DELETE CASCADE:
  -- a setup is meaningless without its project.
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- PUBLIC land-registration numbers (גוש/חלקה/תת) — not PII.
  block_number    text NOT NULL,
  parcel_number   text NOT NULL,
  sub_parcel      text,

  -- Closed lifecycle enum (DB CHECK belt-and-suspenders alongside the Zod
  -- enum at the API edge). draft → confirmed | discarded.
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','confirmed','discarded')),

  -- The user's DRAFT buildings/apartments (strict no-PII Zod shape). Public
  -- record — no pgcrypto. NULL until the first PATCH.
  payload         jsonb,

  -- 'manual' this slice; provider keys arrive with P3b (IParcelDataProvider).
  source          text NOT NULL DEFAULT 'manual',

  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Stamped when the draft is confirmed; NULL on a fresh draft.
  confirmed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_parcel_setups_org_project
  ON parcel_setups (org_id, project_id);

-- ─── RLS (direct org_id — COPIED from tabu_extractions, migration 0068) ─────
ALTER TABLE parcel_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE parcel_setups FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'parcel_setups'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON parcel_setups
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; lifecycle is a status transition) ────────
GRANT SELECT, INSERT, UPDATE ON parcel_setups TO app_user;
REVOKE DELETE ON parcel_setups FROM app_user;

-- ─── provenance: buildings created BY a confirmed setup (mirror 0071) ────────
ALTER TABLE buildings ADD COLUMN IF NOT EXISTS source_parcel_setup_id uuid REFERENCES parcel_setups(id);
