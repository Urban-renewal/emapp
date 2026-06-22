-- 0081: documents — BEFORE-INSERT REJECT a row that is inserted ALREADY-uploaded
-- AND sensitive AND not-yet-encrypted (the 0080 CHECK invariant), at the INSERT
-- seam.
--
-- WHY REJECT (not derive):
-- An earlier draft DERIVED `bytes_encrypted := true` for such a row. That was a
-- SECURITY HOLE: it silently marked a row "encrypted at rest" WITHOUT anything
-- actually encrypting the bytes — so any future writer that INSERTs a sensitive,
-- already-uploaded, plaintext object would have its row stamped
-- bytes_encrypted=true, defeating the 0080 CHECK on INSERT and re-arming the
-- exact drift class (claimed-encrypted-but-plaintext) this Gate-6 work closes.
-- The invariant must be "ENCRYPT OR BE REJECTED", never "claimed-encrypted-but-
-- plaintext". So the trigger now RAISES instead of deriving: an INSERT that would
-- store plaintext sensitive bytes is refused at the DB layer, mirroring the 0080
-- CHECK but with a clear, actionable error.
--
-- WHY a trigger (and why INSERT-ONLY):
-- The 0080 CHECK `NOT (sensitive AND uploaded_at IS NOT NULL AND NOT bytes_encrypted)`
-- already rejects such a row, but with a generic constraint-violation message.
-- This trigger gives a precise, named failure at the INSERT seam and documents
-- the sanctioned escape hatch (replica role) for the few fixtures that must
-- reproduce the legacy pre-state.
--
-- WHY this does NOT break document creation:
--   * The ONLY production INSERT (documents.service.ts create) inserts with
--     uploaded_at = NULL (bytes arrive later at finalize) → the predicate is
--     false (uploaded_at IS NULL) → the trigger is a NO-OP at create, and the
--     real encrypt-at-rest happens at finalize.
--   * The dangerous historical drift (sensitive flipped ON over a PLAINTEXT
--     object) happens on UPDATE (update-retype + remediationSweep), NOT INSERT.
--     Those paths now re-encrypt IN the audited tx (set bytes_encrypted=true
--     alongside the object overwrite) and the 0080 CHECK still catches any future
--     flip that forgets to.
--
-- A backfill / regression test (or a seeder) that must reproduce the legacy
-- `sensitive && !bytes_encrypted && uploaded` pre-state INSERTs under
-- `SET LOCAL session_replication_role = 'replica'` (skips the trigger), which is
-- the sanctioned way to seed a pre-constraint row — the same pattern the
-- failclose spec uses.
--
-- Reversibility: HIGH. DROP TRIGGER + DROP FUNCTION restores prior behaviour.
-- Idempotent/guarded so a concurrent test-worker migrate() is safe.

CREATE OR REPLACE FUNCTION documents_derive_encrypted_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A sensitive row that ALREADY has bytes at rest (uploaded) and is NOT marked
  -- encrypted would be PLAINTEXT PII at rest — exactly the 0080 CHECK's surface.
  -- REJECT it (never silently claim encryption that did not happen).
  IF NEW.sensitive AND NEW.uploaded_at IS NOT NULL AND NOT NEW.bytes_encrypted THEN
    RAISE EXCEPTION 'sensitive document inserted with bytes at rest but bytes_encrypted=false (plaintext-at-rest is forbidden; encrypt the object and set bytes_encrypted=true, or seed pre-constraint rows under session_replication_role=replica)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_documents_derive_encrypted_on_insert'
      AND tgrelid = 'public.documents'::regclass
  ) THEN
    CREATE TRIGGER trg_documents_derive_encrypted_on_insert
      BEFORE INSERT ON documents
      FOR EACH ROW
      EXECUTE FUNCTION documents_derive_encrypted_on_insert();
  END IF;
END
$$;
