-- 0080: documents — couple `sensitive` to `bytes_encrypted` at the DB layer.
-- Gate-6 SECURITY: a SENSITIVE document (national_id / נסח PII) that has BYTES
-- AT REST (uploaded_at IS NOT NULL) MUST be encrypted at rest (bytes_encrypted=
-- true). The two flags drifted apart historically (update-retype +
-- remediationSweep flipped sensitive ON without re-encrypting), leaving PII-dense
-- objects PLAINTEXT in R2 and plain-presigned — including to unauthenticated
-- signers. The code paths are now fixed forward (re-encrypt on flip + serving
-- fail-close); this CHECK makes the invariant STRUCTURAL so the drift can never
-- recur silently.
--
-- The CHECK is qualified by `uploaded_at IS NOT NULL` on PURPOSE: the normal
-- create flow inserts a sensitive doc row FIRST (bytes_encrypted=false, no bytes
-- yet) and only later finalises the upload. A sensitive doc with NO object at
-- rest leaks nothing, so it is legitimately allowed; the invariant binds only
-- once there are PLAINTEXT bytes that could be served. (An unqualified
-- `NOT (sensitive AND NOT bytes_encrypted)` would reject the pre-upload row and
-- break document creation.)
--
-- ⚠️ ORDERING — APPLY THIS MIGRATION ONLY *AFTER* THE BACKFILL HAS RUN.
-- The existing population includes sensitive && NOT bytes_encrypted rows. Adding
-- this CHECK before re-encrypting them would FAIL (the constraint is validated
-- against existing rows) OR — worse — block the very re-encrypt UPDATEs that fix
-- them. The owner runbook is:
--   1. review the dry-run (pnpm --filter @emapp/db reencrypt:sensitive)
--   2. run --apply per env (staging → prod) until 0 candidates remain
--   3. THEN apply THIS migration (the population now satisfies the CHECK).
-- Quarantined docs (missing-R2 / 21-byte stubs) MUST be archived or remediated
-- before this lands, else the CHECK rejects them too.
--
-- Reversibility: HIGH. ALTER TABLE documents DROP CONSTRAINT
-- documents_sensitive_encrypted_at_rest restores the prior state.
-- Idempotent/guarded so a concurrent test-worker migrate() is safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_sensitive_encrypted_at_rest'
      AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_sensitive_encrypted_at_rest
      CHECK (NOT (sensitive AND uploaded_at IS NOT NULL AND NOT bytes_encrypted));
  END IF;
END
$$;
