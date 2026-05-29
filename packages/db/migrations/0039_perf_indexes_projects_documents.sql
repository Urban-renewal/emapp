-- 0039: perf indexes for projects + documents list pagination
--
-- PERF-3 (FINDINGS-REGISTER, perf audit): GET /api/v1/projects and
-- GET /api/v1/documents both page with
--   WHERE archived_at IS NULL ORDER BY created_at DESC, id DESC LIMIT n+1
-- (org-scoped by RLS) — see projects.service.ts:198-208 and
-- documents.service.ts:485-488. No index covered the (org_id, created_at,
-- id) ordering, so under RLS the planner fell back to a whole-org in-RAM
-- Sort at scale — the same class of finding already closed for owners
-- (idx_owners_org_created_desc) and for tasks/memberships in migration 0037.
--
-- These mirror 0037 exactly: partial composite indexes on the rows the list
-- predicate actually selects (archived_at IS NULL), so the planner gets the
-- ORDER BY for free from an index-ordered scan instead of a Sort node, and
-- the index stays small (soft-deleted rows excluded).
--
-- Reversibility: pure DROP INDEX. Both indexes are additive — no existing
-- query relies on them; the planner just gains a faster, sort-free path.
--   DROP INDEX IF EXISTS idx_projects_org_created;
--   DROP INDEX IF EXISTS idx_documents_org_created;

-- projects list (Manager full list + Agent assigned-only list; both ORDER BY
-- created_at DESC, id DESC over archived_at IS NULL rows).
CREATE INDEX IF NOT EXISTS idx_projects_org_created
  ON projects (org_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

-- documents list (org-wide + project/apartment-scoped + Agent assignment
-- scoped; all share the created_at DESC, id DESC keyset ordering).
CREATE INDEX IF NOT EXISTS idx_documents_org_created
  ON documents (org_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;
