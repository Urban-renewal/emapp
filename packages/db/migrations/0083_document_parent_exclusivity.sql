-- 0083 — DOCUMENT PARENT EXCLUSIVITY (at-scale single-source reconciliation)
--
-- OWNER-GATED: this migration BACKFILLS existing rows + adds a CHECK constraint.
-- Per the standing gates, a data backfill on live data waits for the owner's
-- one-click apply. The application-layer fix (CreateDocumentInput refine + the
-- DocumentsService guard + the seeders) already PREVENTS new both-parent rows;
-- this closes the structural gap and corrects historical rows.
--
-- ROOT CAUSE (verified at scale on the local DB, Alpha org f4c183e2…):
-- A document could carry BOTH project_id AND apartment_id. The canonical
-- signature-doc resolution (packages/db/src/helpers/signature-progress.ts) is a
-- UNION of the project-level path (documents.project_id = P) and the
-- apartment-level path (apartment → building → project). A both-parent doc is
-- therefore reachable from TWO projects at once. The whole-org home KPI
-- (computeOrgStats) UNION-counts each doc ONCE; the per-project board
-- (signatureProgressByProject, run once per project) counts it under BOTH
-- projects. So the home KPI and the per-project boards rendered on the SAME
-- screen could not reconcile — the "0 מתוך X" divergence class. Measured on
-- Alpha: KPI 38 signed / 6 pending vs board-sum 62 / 8 (24 phantom signed),
-- caused by 27 cross-project both-parent docs; fleet-wide 41 both-parent rows
-- across 13 orgs (26 cross-project).
--
-- THE INVARIANT: a document hangs off AT MOST ONE structural parent — a project,
-- an apartment, or neither (org-level). The apartment ALREADY resolves to a
-- project via its building, so the apartment is the single source of the doc's
-- project linkage; project_id must be NULL when apartment_id is set.

-- 1) BACKFILL — apartment wins (mirrors the production write path + the seeders).
--    Verified safe: every both-parent doc has a valid apartment→building→project
--    chain (0 dangling), so nulling project_id NEVER orphans a doc or loses a
--    signature — each remains reachable via the apartment path, counted under ONE
--    project instead of two.
UPDATE documents
   SET project_id = NULL,
       updated_at = now()
 WHERE project_id IS NOT NULL
   AND apartment_id IS NOT NULL;

-- 2) STRUCTURAL GUARANTEE — make the invariant impossible to violate again at the
--    DB layer (defense-in-depth beneath the Zod refine + the service guard).
ALTER TABLE documents
  ADD CONSTRAINT documents_parent_exclusive
  CHECK (NOT (project_id IS NOT NULL AND apartment_id IS NOT NULL));
