-- 0068: tabu_extractions — Slice 7a "Tabu extraction ENVELOPE + lifecycle".
--
-- Spec: V12 Phase-5, slice 7a. A `tabu_extraction` is the ENVELOPE around a
-- single Tabu (נסח טאבו) extraction run on an apartment: it points at the
-- FINALIZED source document the parse will read, and carries a draft→confirmed/
-- discarded lifecycle. This slice is the envelope ONLY — NO parsing, NO
-- owner/share PII rows, NO commit (those are slices 7b/7c). The table therefore
-- holds no PII; it is a thin lifecycle record on (apartment, source document).
--
-- This migration:
--   1. CREATE TABLE tabu_extractions (org_id-scoped; closed status enum;
--      apartment_id → apartments, source_document_id → documents).
--   2. RLS — direct org_id policy (documents-style, migration 0004): a LEAF row
--      that carries its own org_id, isolated by the app.organization_id GUC.
--      FORCE ROW LEVEL SECURITY. Mirrors `documents` exactly.
--   3. GRANTs to app_user (SELECT/INSERT/UPDATE; no DELETE — confirm/discard is
--      a status transition, never a hard delete).
--
-- Reversibility: HIGH. DROP TABLE tabu_extractions restores the prior state
-- (no data move, no constraint change on any other table).

-- ════════════════════ tabu_extractions ══════════════════════════════
CREATE TABLE IF NOT EXISTS tabu_extractions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Direct org_id isolation key (documents-style). RLS gates reads/writes by
  -- the app.organization_id GUC below.
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- The apartment this extraction run is attached to. ON DELETE CASCADE: an
  -- extraction is meaningless without its apartment.
  apartment_id        uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,

  -- The FINALIZED source document the parse reads (a נסח טאבו PDF). The service
  -- enforces uploaded_at IS NOT NULL AND scan_status = 'clean' AND that the
  -- document is scoped to THIS apartment before inserting. ON DELETE RESTRICT:
  -- the source must outlive the extraction that references it.
  source_document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,

  -- Closed lifecycle enum (DB CHECK belt-and-suspenders alongside the Zod enum
  -- at the API edge). draft → confirmed (7c commit) | discarded.
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','confirmed','discarded')),

  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Stamped when the draft is confirmed (7c); NULL on a fresh draft.
  confirmed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_tabu_extractions_org_apartment
  ON tabu_extractions (org_id, apartment_id);

-- ─── RLS (direct org_id — COPIED from documents, migration 0004) ─────────────
ALTER TABLE tabu_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tabu_extractions FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tabu_extractions'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON tabu_extractions
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; lifecycle is a status transition) ────
GRANT SELECT, INSERT, UPDATE ON tabu_extractions TO app_user;
REVOKE DELETE ON tabu_extractions FROM app_user;
