-- 0071: ownerships.source_extraction_id — Slice 7c provenance
-- (docs/DESIGN-phase5-tabu-extraction.md §5).
--
-- Every ownership row written by POST /tabu-extractions/:id/confirm carries
-- the extraction it came from (owner-decision D-P5.1: the manual-confirm
-- commit must be traceable back to the reviewed נסח parse). NULLable, NO
-- backfill: pre-existing rows (manual replaceSet / import) stay NULL.
--
-- Reversibility: HIGH. ALTER TABLE ownerships DROP COLUMN source_extraction_id
-- restores the prior state.
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

ALTER TABLE ownerships ADD COLUMN IF NOT EXISTS source_extraction_id uuid REFERENCES tabu_extractions(id);
