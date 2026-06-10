-- 0062 — project create-form enrichment (Roadmap P3): the urban-renewal data
-- the project create-form currently omits. ALL additive + NULLABLE → zero
-- breakage to existing projects or the create flow. RLS already covers
-- `projects` via the `tenant_isolation` policy on `org_id` (migration 0004);
-- new columns ride that policy with no new policy needed.
--
-- Five capability groups (owner-approved Gate-6):
--
--   1. developer / יזם — the developer/contractor entity executing the
--      project. Often DISTINCT from the managing org. Free-text name +
--      optional company-id (ח.פ.). Both nullable.
--
--   2. unit / תמורה ratio — owner-compensation basics. Modelled GENERICALLY
--      (not over-fit to one deal structure): existing vs planned unit counts
--      (the expansion) + an optional extra-area figure. All nullable.
--
--   3. relocation / פינוי — for demolish-rebuild (תמ"א 38/2, פינוי-בינוי)
--      residents vacate during construction. `relocation_type` is a closed
--      set (none | rent_comp | alt_housing), pinned by a CHECK so the storage
--      layer is belt-and-suspenders alongside the Zod enum at the API edge;
--      NULL is allowed (unspecified / strengthening track). Free-text notes
--      alongside. The CHECK admits NULL (unspecified) + the three values.
--
--   4. future project-type — the `project_type` enum gains an additive
--      'other' value so FUTURE renewal tracks (e.g. the post-2026 תמ"א-sunset
--      successor / חלופת שקד) can be represented WITHOUT editing the existing
--      tama38_1/tama38_2/pinui_binui values and WITHOUT touching the LOCKED
--      D.18 `project_status` enum (which is NOT modified here). A nullable
--      free-text `type_label` carries the human name of the 'other' track.
--      ADD VALUE is additive-only and irreversible by design; safe in a tx on
--      PG16 because the new value is NOT referenced within this same migration.
--
--   5. parcel provenance / גוש-חלקה — the project site's lead land-registration
--      identity: block (גוש) + parcel (חלקה) + optional sub-parcel (תת-חלקה).
--      Distinct from the per-building block/parcel columns (a project can span
--      many buildings/parcels; these capture the headline registration). All
--      nullable text.

-- 4. Future renewal-track support — additive enum value (NOT used below).
ALTER TYPE project_type ADD VALUE IF NOT EXISTS 'other';

-- 1. developer / יזם
ALTER TABLE projects ADD COLUMN developer_name text;
ALTER TABLE projects ADD COLUMN developer_company_id text;

-- 2. unit / תמורה ratio (owner compensation basics — generic + nullable)
ALTER TABLE projects ADD COLUMN existing_units integer;
ALTER TABLE projects ADD COLUMN planned_units integer;
ALTER TABLE projects ADD COLUMN extra_area_sqm numeric(10, 2);

-- 3. relocation / פינוי
ALTER TABLE projects ADD COLUMN relocation_type text;
ALTER TABLE projects ADD COLUMN relocation_notes text;
ALTER TABLE projects
  ADD CONSTRAINT projects_relocation_type_check
  CHECK (relocation_type IS NULL OR relocation_type IN ('none', 'rent_comp', 'alt_housing'));

-- 4. Future-track free-text label (paired with the 'other' enum value above).
ALTER TABLE projects ADD COLUMN type_label text;

-- 5. parcel provenance / גוש-חלקה (project-level lead registration)
ALTER TABLE projects ADD COLUMN block text;
ALTER TABLE projects ADD COLUMN parcel text;
ALTER TABLE projects ADD COLUMN subparcel text;
