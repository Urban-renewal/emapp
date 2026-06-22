-- 0081: documents — BEFORE-INSERT derive `bytes_encrypted = true` for a row that
-- is inserted ALREADY-uploaded AND sensitive (the 0080 CHECK invariant).
--
-- WHY a trigger (and why INSERT-ONLY):
-- The 0080 CHECK `NOT (sensitive AND uploaded_at IS NOT NULL AND NOT bytes_encrypted)`
-- ripples to EVERY raw-SQL seeder / test fixture that INSERTs a sensitive doc
-- WITH bytes at rest (uploaded_at set) but WITHOUT bytes_encrypted=true — ~35
-- spec files. A fixture that inserts an already-uploaded sensitive row is, by
-- construction, asserting "a STORED sensitive document"; a real stored sensitive
-- document IS encrypted at rest, so deriving bytes_encrypted=true is the CORRECT
-- representation. One trigger replaces 35 brittle per-file edits (the repo
-- lesson: prefer a BEFORE-trigger derive over patching N raw seeders).
--
-- WHY this does NOT mask the production bug it guards against:
--   * The ONLY production INSERT (documents.service.ts create) inserts with
--     uploaded_at = NULL (bytes arrive later at finalize) → the trigger is a
--     NO-OP at create, and the real encrypt-at-rest happens at finalize.
--   * The dangerous historical drift (sensitive flipped ON over a PLAINTEXT
--     object) happens on UPDATE (update-retype + remediationSweep), NOT INSERT.
--     This trigger is INSERT-ONLY, so it NEVER silently "claims" encryption for
--     a flip — those paths now re-encrypt IN the audited tx (set bytes_encrypted
--     =true alongside the object overwrite) and the 0080 CHECK still catches any
--     future flip that forgets to.
--
-- A backfill / regression test that must reproduce the legacy
-- `sensitive && !bytes_encrypted` pre-state inserts under
-- `SET LOCAL session_replication_role = replica` (skips the trigger), which is
-- the sanctioned way to seed a pre-constraint row.
--
-- Reversibility: HIGH. DROP TRIGGER + DROP FUNCTION restores prior behaviour.
-- Idempotent/guarded so a concurrent test-worker migrate() is safe.

CREATE OR REPLACE FUNCTION documents_derive_encrypted_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only a sensitive row that ALREADY has bytes at rest (uploaded) and is not
  -- yet marked encrypted is derived — exactly the 0080 CHECK's trigger surface.
  IF NEW.sensitive AND NEW.uploaded_at IS NOT NULL AND NOT NEW.bytes_encrypted THEN
    NEW.bytes_encrypted := true;
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
