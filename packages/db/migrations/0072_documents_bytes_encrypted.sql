-- 0072: documents.bytes_encrypted — Slice 7d app-envelope encryption
-- (docs/DESIGN-phase5-tabu-extraction.md §7d; D-P5.4 second half).
--
-- A SENSITIVE document's bytes are uploaded through the API
-- (POST /documents/:id/content), scanned in plaintext, then stored as an
-- AES-256-GCM app-envelope (EMAPPENC|v1|keyId|iv|tag|ciphertext) whose key
-- (DOC_ENCRYPTION_KEY, Infisical) never touches R2. The envelope is
-- self-describing — this column exists so the SERVING path knows ahead of
-- the object read whether to decrypt-stream (true) or mint the existing
-- presigned GET (false). Plain documents stay presign-based and keep false.
--
-- Reversibility: HIGH. ALTER TABLE documents DROP COLUMN bytes_encrypted
-- restores the prior state.
-- Idempotent/guarded so concurrent test-worker migrate() is safe.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS bytes_encrypted boolean NOT NULL DEFAULT false;
