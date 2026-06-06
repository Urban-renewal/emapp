-- 0049: documents.uploaded_at — fix the "ghost document" / NoSuchKey class
--
-- A document row is INSERTED at create time (POST /documents), before the
-- client has PUT any bytes to R2 + called POST /documents/:id/finalize. The
-- table had no "upload confirmed" flag, so a created-but-never-finalised doc
-- (interrupted/failed upload, tab closed) was indistinguishable from a good one
-- in every read query — it appeared in lists + minted a presigned download URL
-- that 404s on R2 (NoSuchKey). Owner hit exactly this.
--
-- Fix: uploaded_at — NULL on create, stamped by a SUCCESSFUL finalize. The
-- serving read paths require uploaded_at IS NOT NULL, so a ghost is never
-- served. (Provider-agnostic — works for R2 + the Fake test provider, unlike a
-- head() existence check whose null is ambiguous between missing-vs-no-attest.)
--
-- Backfill: every EXISTING non-archived doc is treated as uploaded (set to
-- updated_at) so legitimate pre-migration documents stay visible. Only NEW
-- documents are gated by the create→finalize lifecycle. (Pre-existing ghosts,
-- if any, remain — a data-cleanup concern, not this forward-fix.)
-- Forward-only; additive.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;

UPDATE documents
  SET uploaded_at = updated_at
  WHERE uploaded_at IS NULL
    AND archived_at IS NULL;
