-- 0077: document taxonomy — doc_scope + doc_scope_id + owner_id + backfill (DH1).
--
-- Spec: docs/MASTER-PLAN-V13.md Wave B DH1 (ISOLATED lane; full-suite gate
-- BEFORE DH2/3/4). The council decided the `documents` spine grows a CLOSED,
-- TYPED scope link so a doc can hang off the org, a project, an apartment, or
-- (new) a single OWNER — replacing the two ad-hoc, untyped nullable parent
-- columns (project_id / apartment_id) as the canonical scope concept. Those two
-- columns are KEPT for back-compat (the create/finalize/list/download paths and
-- every existing seeder still write/read them); this migration is PURELY
-- ADDITIVE + a one-time backfill — it removes nothing and rewrites no behavior.
--
-- This migration:
--   1. CREATE TYPE doc_scope — closed enum org|project|apartment|owner.
--   2. documents.doc_scope — doc_scope NOT NULL DEFAULT 'org'. The default makes
--      every pre-existing AND future raw INSERT that omits it land as 'org'
--      (back-compat: no seeder/insert breaks — see the CHECK note below).
--   3. documents.doc_scope_id — uuid NULL. The typed scope target id (the
--      project / apartment / owner id the doc is scoped to). NULL for org-scope.
--   4. documents.owner_id — uuid NULL, FK → owners ON DELETE SET NULL. The new
--      explicit owner link (a doc about a specific owner, e.g. their נסח/ID).
--      SET NULL (not RESTRICT/CASCADE): erasing/removing an owner must neither
--      block the delete nor destroy the document — the doc survives, de-linked.
--   5. BACKFILL existing rows — derive doc_scope + doc_scope_id from the present
--      project_id/apartment_id (apartment wins over project; else org). Set-based.
--   6. CHECK documents_doc_scope_id_consistent — scope_id presence is consistent
--      with scope: org ⇒ scope_id IS NULL; project|apartment|owner ⇒ scope_id
--      IS NOT NULL. Added AFTER the backfill so it validates already-consistent
--      data. NOTE: the CHECK constrains ONLY (scope, scope_id) internal
--      consistency — it does NOT couple doc_scope to the legacy
--      project_id/apartment_id columns. A future/legacy raw INSERT that sets
--      project_id but omits doc_scope therefore stays valid: it lands as
--      scope='org', scope_id=NULL (CHECK passes). This is the deliberate
--      no-seeder-patch design — the legacy columns remain the operative parent
--      link until DH2+ migrate callers onto the scope spine.
--
-- Reversibility: HIGH. ALTER TABLE documents DROP CONSTRAINT
-- documents_doc_scope_id_consistent; DROP COLUMN owner_id, doc_scope_id,
-- doc_scope; DROP TYPE doc_scope — restores the prior state exactly (the legacy
-- project_id/apartment_id columns were never touched).
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

-- ════════════════════ doc_scope enum ════════════════════════════════════
DO $$ BEGIN
  CREATE TYPE "public"."doc_scope" AS ENUM('org', 'project', 'apartment', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ════════════════════ columns (additive) ════════════════════════════════
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS doc_scope "doc_scope" NOT NULL DEFAULT 'org';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS doc_scope_id uuid;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS owner_id uuid;

-- owner_id FK → owners ON DELETE SET NULL (guarded — re-add only if absent).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'documents_owner_id_owners_id_fk'
      AND table_name = 'documents'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_owner_id_owners_id_fk
      FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_owner
  ON documents (owner_id)
  WHERE owner_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_scope
  ON documents (doc_scope, doc_scope_id)
  WHERE doc_scope_id IS NOT NULL AND archived_at IS NULL;

-- ════════════════════ backfill (one-time, set-based) ════════════════════
-- Derive scope from the legacy parent columns. Apartment is MORE SPECIFIC than
-- project, so an apartment-scoped doc wins even if (unexpectedly) both are set.
-- A doc with neither stays scope='org' (the column default) — nothing to do.
-- Idempotent: re-running only ever re-derives the SAME value (the WHERE on the
-- legacy columns is stable), and the DEFAULT already seeded 'org' for all rows.

-- apartment_id present ⇒ scope='apartment', scope_id=apartment_id.
UPDATE documents
   SET doc_scope = 'apartment', doc_scope_id = apartment_id
 WHERE apartment_id IS NOT NULL;

-- project_id present AND no apartment ⇒ scope='project', scope_id=project_id.
UPDATE documents
   SET doc_scope = 'project', doc_scope_id = project_id
 WHERE apartment_id IS NULL
   AND project_id IS NOT NULL;

-- (neither present ⇒ left as scope='org', scope_id=NULL — the default.)

-- ════════════════════ scope/scope_id consistency CHECK ══════════════════
-- Added AFTER the backfill so existing rows are already consistent and the
-- validation pass cannot fail. org ⇒ no target id; every non-org scope ⇒ a
-- target id is required. Guarded so concurrent migrate() is idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'documents_doc_scope_id_consistent'
      AND table_name = 'documents'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_doc_scope_id_consistent
      CHECK (
        (doc_scope = 'org' AND doc_scope_id IS NULL)
        OR (doc_scope <> 'org' AND doc_scope_id IS NOT NULL)
      );
  END IF;
END $$;
