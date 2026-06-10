-- ════════════ 0058 · signatures immutability — erasure-redaction exception ═══
-- Roadmap P0.C1 follow-up (erasure-completeness HIGH #1). Gate-6 (PII).
--
-- 0003 installed `trg_signatures_immutable` (BEFORE UPDATE OR DELETE) whose
-- function RAISEs unconditionally — a recorded signature is forensic evidence
-- and must never change. The data-subject ERASURE right (P0.C1) collides with
-- that: `signatures.signature_blob` is the subject's handwritten-signature SVG
-- (BIOMETRIC PII) and MUST be redactable on erasure, while the legal proof
-- (`document_hash`, `signed_at`, the owner link, `auth_method`, …) stays frozen.
--
-- Resolution: REPLACE the trigger FUNCTION (CREATE OR REPLACE keeps the existing
-- `trg_signatures_immutable` binding) with one that still blocks DELETE and every
-- ordinary UPDATE, but ALLOWS a single, tightly-scoped redaction: an UPDATE that
-- changes EXCLUSIVELY the three redaction columns (`signature_blob`, `signer_ip`,
-- `signer_user_agent`) AND only ever toward their erased targets:
--   - signature_blob      → the fixed '[erased]' tombstone (UTF-8 bytes),
--   - signer_ip           → NULL,
--   - signer_user_agent   → NULL.
-- Any change to ANY other column, any DELETE, or a non-erased target value still
-- RAISEs. Forensic immutability stays intact for the legally-load-bearing fields
-- while the privacy-law redaction is permitted.
--
-- Mechanism: mask the three redaction columns to a constant in BOTH the OLD and
-- NEW jsonb row images and compare the rest. Equal ⇒ nothing outside the
-- redaction set changed. Then assert the NEW redaction values are the erased
-- targets (so the exception can't be abused to write arbitrary blob/ip/ua).
--
-- The erased_blob constant is kept in lock-step with SIGNATURE_BLOB_TOMBSTONE in
-- packages/db/src/helpers/owners.ts (both are the UTF-8 bytes of '[erased]').
--
-- Additive + idempotent + re-runnable (CREATE OR REPLACE). Hand-authored; a
-- meta/_journal.json entry (idx 58) is added in the same commit. NOT applied to
-- shared dev — the Gate-6 P0.C1 PR is HELD for owner sign-off.

CREATE OR REPLACE FUNCTION trigger_signatures_immutable()
RETURNS TRIGGER AS $$
DECLARE
  -- Lock-step with SIGNATURE_BLOB_TOMBSTONE (packages/db/src/helpers/owners.ts).
  erased_blob bytea := convert_to('[erased]', 'UTF8');
  old_masked jsonb;
  new_masked jsonb;
BEGIN
  -- DELETE is never allowed (no erasure path deletes a signature row).
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signatures are immutable and cannot be updated or deleted';
  END IF;

  -- Mask the three redaction columns in both images, then compare the REST.
  -- Equal ⇒ the only columns that moved are within the allowed redaction set.
  old_masked := to_jsonb(OLD)
    || jsonb_build_object('signature_blob', null, 'signer_ip', null, 'signer_user_agent', null);
  new_masked := to_jsonb(NEW)
    || jsonb_build_object('signature_blob', null, 'signer_ip', null, 'signer_user_agent', null);

  IF old_masked IS DISTINCT FROM new_masked THEN
    RAISE EXCEPTION 'signatures are immutable and cannot be updated or deleted';
  END IF;

  -- Only the redaction columns changed; assert they moved to the erased targets.
  IF NEW.signature_blob IS DISTINCT FROM erased_blob
     OR NEW.signer_ip IS NOT NULL
     OR NEW.signer_user_agent IS NOT NULL THEN
    RAISE EXCEPTION 'signatures are immutable except for the erasure redaction (blob->tombstone, signer_ip/ua->NULL)';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
