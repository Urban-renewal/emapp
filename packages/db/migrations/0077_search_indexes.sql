-- 0077: server-side search indexes (NS1, MASTER-PLAN-V13 Wave B).
--
-- Backs the three new keyset-paginated search endpoints:
--   GET /projects?q=&status=&segment=   (q → name trigram ILIKE)
--   GET /owners/search?q=               (q → decrypted-name ILIKE, org-scoped)
--   GET /documents/search?q=&type=&scope=  (q → name trigram ILIKE; type btree)
--
-- pg_trgm gives a GIN index that accelerates `name ILIKE '%q%'` substring
-- matching (the default btree cannot serve a leading-wildcard LIKE). It is
-- enabled here (idempotent) and used for the two CLEARTEXT name columns:
-- projects.name and documents.name.
--
-- OWNERS NOTE (load-bearing — do NOT "fix" by adding a trigram on owner name):
-- owners.name is PII and is stored ENCRYPTED at rest (owners.name_encrypted
-- bytea, cleartext column dropped in migration 0033). There is no cleartext
-- name column to build a trigram GIN over, and indexing the ciphertext would
-- be useless (ciphertext is not order/substring-preserving). The owners search
-- therefore decrypts the name IN-SQL (pgp_sym_decrypt under the withTenant
-- app.encryption_key GUC) and ILIKEs the plaintext within the org's rows. That
-- scan is bounded by the existing idx_owners_org_not_erased / org-scope RLS to
-- one org's owners — acceptable at MVP owner counts; the masked-PII projection
-- (never national_id/phone cleartext) is unchanged. The pre-existing
-- idx_owners_org_name_hash (exact HMAC lookup) stays for the by-PII POST path.
--
-- Reversibility: HIGH. DROP the two indexes; the extension is left in place
-- (harmless, may be shared). Guarded/idempotent so a concurrent test-worker
-- migrate() is safe.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- projects.name substring search (the projects-list `q` filter). GIN trigram so
-- a leading-wildcard ILIKE is index-served. Org isolation is RLS; this index is
-- the substring accelerator on top of it.
CREATE INDEX IF NOT EXISTS idx_projects_name_trgm
  ON projects USING gin (name gin_trgm_ops)
  WHERE archived_at IS NULL;

-- documents.name substring search (the documents-search `q` filter).
CREATE INDEX IF NOT EXISTS idx_documents_name_trgm
  ON documents USING gin (name gin_trgm_ops)
  WHERE archived_at IS NULL;

-- documents.type equality filter (the documents-search `type` filter). Paired
-- with org_id so the planner can satisfy "this org's docs of type X" directly.
CREATE INDEX IF NOT EXISTS idx_documents_org_type
  ON documents (org_id, type)
  WHERE archived_at IS NULL;

-- NB: projects status/created_at btree already exists (idx_projects_org_status,
-- migration 0002) and backs the projects-search `status` + keyset ordering; no
-- new btree is needed there.
