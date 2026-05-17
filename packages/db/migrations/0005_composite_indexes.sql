-- P1.12: Additional composite indexes for common access patterns
-- Most indexes were created in 0002/0003 alongside their tables.
-- These fill in the gaps identified by the P1.12 index inventory.

-- documents: storage_key must be unique (one R2 key per file)
CREATE UNIQUE INDEX IF NOT EXISTS "documents_storage_key_unique"
  ON "documents" USING btree ("storage_key");

-- documents: composite (org_id, project_id) for org-scoped project file listing
-- more targeted than the separate org/project indexes for the common query pattern
CREATE INDEX IF NOT EXISTS "idx_documents_org_project"
  ON "documents" USING btree ("org_id", "project_id")
  WHERE project_id IS NOT NULL AND archived_at IS NULL;

-- signatures: index on document_id for "which signatures reference this document"
CREATE INDEX IF NOT EXISTS "idx_signatures_document"
  ON "signatures" USING btree ("document_id")
  WHERE document_id IS NOT NULL;

-- audit_log: index on actor_user_id for "what did this user do"
CREATE INDEX IF NOT EXISTS "idx_audit_log_actor_user"
  ON "audit_log" USING btree ("actor_user_id", "created_at" DESC NULLS LAST)
  WHERE actor_user_id IS NOT NULL;

-- audit_log: index on actor_contractor_id for "what did this contractor do"
CREATE INDEX IF NOT EXISTS "idx_audit_log_actor_contractor"
  ON "audit_log" USING btree ("actor_contractor_id", "created_at" DESC NULLS LAST)
  WHERE actor_contractor_id IS NOT NULL;

-- notes: composite (org_id, created_by) for "notes by a specific user in org"
CREATE INDEX IF NOT EXISTS "idx_notes_org_author"
  ON "notes" USING btree ("org_id", "created_by")
  WHERE archived_at IS NULL;
