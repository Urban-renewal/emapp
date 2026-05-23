-- v5 audit fix (P0 — Agent A): the D.34 wizard endpoint stores
-- mapping_templates rows with `fingerprint = sha256("manual:${id}")`
-- as a placeholder, NOT the sha256 of the real Excel headers. The
-- future L2 TemplateResolver (Phase 7+) is contractually designed
-- to look up templates by (orgId, sha256(real headers)) — so every
-- manual template stored today would be invisible to L2 tomorrow.
--
-- Fix path: the worker's parseStage already has the parsed headers
-- in memory when it transitions to `awaiting_mapping`. Persist them
-- on the import_jobs row so the API service `submitMapping` can read
-- them back and compute the real fingerprint before INSERTing the
-- template.
--
-- Why a column on import_jobs (not on mapping_templates):
--   - The headers are the JOB's parsed shape, not the template's
--     mapping itself. A template's `mapping.headers` field (already
--     in the jsonb) is the snapshot at template-creation time and
--     belongs there; this new column is the worker→service handoff.
--   - Nullable: pre-S7 jobs (and any future job that never reaches
--     parseStage) have no headers to store.
--   - jsonb (not text[]) for consistency with mapping_templates.mapping
--     which is also jsonb.

ALTER TABLE import_jobs
  ADD COLUMN parsed_headers jsonb;

-- No GRANT needed — app_user already has SELECT/INSERT/UPDATE on
-- import_jobs from migration 0008/0009 (column-level grants in
-- Postgres apply to all columns by default).
--
-- No RLS policy change — the existing tenant_isolation policy on
-- import_jobs already gates this column with the rest of the row.
