-- 0069: tabu_extraction_rows — Slice 7b-extract "RUN a pluggable extraction
-- engine on a draft tabu_extraction and store the parsed owner/share rows
-- ENCRYPTED".
--
-- Spec: V12 Phase-5, slice 7b-extract. The 7a envelope (0068) is a thin
-- lifecycle record on (apartment, source document) and holds NO PII. THIS slice
-- adds the parse OUTPUT: one row per owner the extraction engine found, with the
-- owner PII (name, national_id) pgcrypto-ENCRYPTED at rest (never plaintext,
-- never logged — same posture as owners.*_encrypted, migration 0029/v8-S3), plus
-- the share fraction + a per-row confidence + a stable position for ordering.
--
-- This migration:
--   1. CREATE TABLE tabu_extraction_rows (org_id-scoped LEAF; extraction_id →
--      tabu_extractions ON DELETE CASCADE — a row is meaningless without its
--      parent extraction; PII columns are bytea ciphertext, NULLable so the
--      engine can emit a row that is missing a name OR a national_id).
--   2. RLS — direct org_id policy (documents-style, migration 0004), FORCE ROW
--      LEVEL SECURITY + the documents-style tenant_isolation policy. Mirrors
--      tabu_extractions (0068) exactly.
--   3. GRANTs to app_user (SELECT/INSERT/DELETE/UPDATE): a re-run REPLACES the
--      prior rows for a draft (DELETE-then-INSERT), and an edit (7c) UPDATEs a
--      cell — so app_user needs DELETE + UPDATE here (unlike the envelope, which
--      is status-only).
--   4. ALTER tabu_extractions ADD the 7b stamp columns: raw_text_encrypted
--      (the full source text, ENCRYPTED — it embeds PII), extraction_engine
--      (the engineId that produced the rows, e.g. 'stub'/'gemini'), extracted_at.
--
-- Reversibility: HIGH. DROP TABLE tabu_extraction_rows + the three ALTER ... DROP
-- COLUMN restore the prior state (no data move, no constraint change elsewhere).

-- ════════════════════ tabu_extraction_rows ══════════════════════════════
CREATE TABLE IF NOT EXISTS tabu_extraction_rows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The parent extraction. ON DELETE CASCADE: a parsed row is meaningless once
  -- its extraction envelope is gone.
  extraction_id         uuid NOT NULL REFERENCES tabu_extractions(id) ON DELETE CASCADE,

  -- Direct org_id isolation key (documents-style). RLS gates reads/writes by the
  -- app.organization_id GUC below. (Denormalised from the parent so the leaf can
  -- be isolated without a join.)
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- PII — pgcrypto ciphertext, NEVER plaintext, NEVER logged. NULLable: the
  -- engine may emit a row that is missing a name OR a national_id (a partial
  -- parse the 7c review step will complete).
  name_encrypted        bytea,
  national_id_encrypted bytea,

  -- The ownership share fraction the engine parsed (e.g. 1/2). NULLable.
  share_numerator       bigint,
  share_denominator     bigint,

  -- Per-row engine confidence in [0,1]. NULLable (an engine may not score).
  confidence            real,

  -- Set true once a human edits this row in the 7c review surface; the engine
  -- only ever writes false.
  edited                boolean NOT NULL DEFAULT false,

  -- Stable display/order position within the extraction (0-based as emitted).
  position              integer NOT NULL,

  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tabu_extraction_rows_extraction
  ON tabu_extraction_rows (extraction_id, position);

CREATE INDEX IF NOT EXISTS idx_tabu_extraction_rows_org
  ON tabu_extraction_rows (org_id);

-- ─── RLS (direct org_id — COPIED from tabu_extractions 0068 / documents 0004) ──
ALTER TABLE tabu_extraction_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE tabu_extraction_rows FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tabu_extraction_rows'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON tabu_extraction_rows
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ─── grants (app_user needs DELETE + UPDATE here: re-run REPLACES rows, 7c
--     edits a cell) ─────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON tabu_extraction_rows TO app_user;

-- ════════════════════ tabu_extractions — 7b stamp columns ════════════════════
-- raw_text_encrypted: the full source text the engine read, ENCRYPTED (it embeds
--   PII — name/national_id appear verbatim). NEVER plaintext, NEVER logged.
-- extraction_engine: the engineId that produced the rows (e.g. 'stub').
-- extracted_at: when the run completed.
ALTER TABLE tabu_extractions ADD COLUMN IF NOT EXISTS raw_text_encrypted bytea;
ALTER TABLE tabu_extractions ADD COLUMN IF NOT EXISTS extraction_engine  text;
ALTER TABLE tabu_extractions ADD COLUMN IF NOT EXISTS extracted_at       timestamptz;
