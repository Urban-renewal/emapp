-- 0041 (D.46): per-agent capability matrix on memberships.
--
-- A curated set of 6 manager-controlled toggles (JSONB, D.17), enforced
-- server-side. Meaningful only for role='agent' (managers implicitly hold
-- all capabilities; viewers are read-only). Default = everything OFF except
-- `view_owners` (ON; PII masked per D.47).
--
-- Existing rows backfill to the default via the column DEFAULT, so every
-- current agent starts with NO edit/manage capabilities (least-privilege)
-- and `view_owners` on — a safe, non-escalating baseline.
--
-- NOT NULL + DEFAULT means the catalog rewrite is a fast metadata-only
-- change on PG (the default is stored in pg_attribute, not written per-row).
-- Reversibility: pure DROP COLUMN (additive, nothing references it yet
-- except the new capability enforcement, which treats a missing flag as
-- false / not-granted).
ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT
    '{"edit_project_data": false, "manage_documents": false, "manage_signatures": false, "manage_tasks": false, "run_imports": false, "view_owners": true}'::jsonb;
