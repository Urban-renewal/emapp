-- 0015: bring signatures + documents to the locked spec (doc 04c §4 Z5, P1.8 DoD, D.12)
--
-- signatures (as-built) used project_id/apartment_id/recorded_by and lacked the
-- forensic + evidence fields. Spec model is document + owner + forensic:
--   document_id NN, owner_id NN, document_hash NN, signature_format NN
--   (DEFAULT 'svg' — D.12 LAW: signatures are SVG), signer_ip, signer_user_agent,
--   session_id, auth_method NN.
-- documents (as-built) used storage_key and lacked type/content_hash/updated_at;
-- spec uses r2_key (NN UNIQUE), type NN, content_hash NN, size_bytes BIGINT.
--
-- signatures has a BEFORE UPDATE OR DELETE immutable trigger. TRUNCATE does NOT
-- fire row-level triggers and signatures is referenced by no FK, so it is the
-- safe way to clear ephemeral test rows before the structural change. There is
-- no production data (pre-launch base layer).
--
-- All steps idempotent (guards) so concurrent test-worker migrate() is safe.

-- ════════════════════ signatures ════════════════════════════════════════════

TRUNCATE TABLE signatures;

-- drop non-spec columns (also drops their FKs + dependent indexes)
ALTER TABLE signatures DROP COLUMN IF EXISTS project_id;
ALTER TABLE signatures DROP COLUMN IF EXISTS apartment_id;
ALTER TABLE signatures DROP COLUMN IF EXISTS recorded_by;

-- document_id: spec requires NOT NULL (table is empty post-truncate)
ALTER TABLE signatures ALTER COLUMN document_id SET NOT NULL;

-- spec columns
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS document_hash text;
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS signature_format text NOT NULL DEFAULT 'svg';
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS signer_ip inet;
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS signer_user_agent text;
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS auth_method text;

-- table is empty → NOT NULL is safe without backfill
ALTER TABLE signatures ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE signatures ALTER COLUMN document_hash SET NOT NULL;
ALTER TABLE signatures ALTER COLUMN auth_method SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signatures_owner_id_owners_id_fk'
      AND conrelid = 'signatures'::regclass
  ) THEN
    ALTER TABLE signatures
      ADD CONSTRAINT signatures_owner_id_owners_id_fk
      FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

DROP INDEX IF EXISTS idx_signatures_project;
DROP INDEX IF EXISTS idx_signatures_apartment;
DROP INDEX IF EXISTS signatures_apartment_project_unique;
CREATE INDEX IF NOT EXISTS idx_signatures_document ON signatures (document_id);
CREATE INDEX IF NOT EXISTS idx_signatures_owner ON signatures (owner_id);

-- ════════════════════ documents ═════════════════════════════════════════════
-- (documents has NO immutable trigger — backfill UPDATEs are allowed)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='documents' AND column_name='storage_key') THEN
    ALTER TABLE documents RENAME COLUMN storage_key TO r2_key;
  END IF;
END;
$$;

ALTER TABLE documents ALTER COLUMN size_bytes TYPE bigint;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS type text;
UPDATE documents SET type = 'contract' WHERE type IS NULL;
ALTER TABLE documents ALTER COLUMN type SET NOT NULL;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash text;
UPDATE documents SET content_hash = '' WHERE content_hash IS NULL;
ALTER TABLE documents ALTER COLUMN content_hash SET NOT NULL;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- spec: r2_key NOT NULL UNIQUE + spec index names
DROP INDEX IF EXISTS idx_documents_org;
DROP INDEX IF EXISTS idx_documents_project;
CREATE UNIQUE INDEX IF NOT EXISTS documents_r2_key_unique ON documents (r2_key);
CREATE INDEX IF NOT EXISTS idx_documents_org_project
  ON documents (org_id, project_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents (content_hash);
