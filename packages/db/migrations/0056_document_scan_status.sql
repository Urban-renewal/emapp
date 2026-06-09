-- ════════════════════ 0055 · documents anti-malware scan status (P0.B1) ═══════
-- Owner-approved Gate-6 (migration) change. Additive + reversible (D.39 posture).
--
-- WHY: uploaded documents are served to residents via short-lived presigned
-- URLs. There was NO content/malware scan — only a MIME allow-list + size
-- bound — so EMAPP could distribute an owner-uploaded malicious file (a real
-- prod risk). P0.B1 adds a pluggable IFileScanProvider (Noop in dev/test,
-- ClamAV in prod) and gates downloadability on a `clean` verdict.
--
-- COLUMNS:
--   scan_status     'pending' | 'clean' | 'infected' | 'error'.
--                   NEW rows default to 'pending' (NOT downloadable). A
--                   SUCCESSFUL finalize runs the scan and stamps the verdict.
--                   The download path serves ONLY 'clean' (FAIL-CLOSED:
--                   unscanned/infected/error ⇒ never servable).
--   scan_signature  AV signature/threat label for an 'infected' verdict, or a
--                   short content-free reason for 'error'. NEVER file content
--                   or PII (matches the no-PII-in-logs rule).
--
-- BACKFILL: every EXISTING non-archived document is treated as 'clean' so
-- legitimate pre-migration documents stay downloadable (they pre-date the
-- scanner; this is a forward-only gate for NEW uploads). Operators who want to
-- retro-scan the existing corpus can re-set rows to 'pending' and re-run a
-- batch scan — out of scope for this forward-fix.
--
-- Hand-authored (drizzle-kit is unusable here — see packages/db/CLAUDE.md); the
-- meta/_journal.json entry (idx 55) is added in the same commit. Idempotent +
-- re-runnable (IF NOT EXISTS / guarded constraint add).

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS scan_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS scan_signature text;

-- Closed value set (defense-in-depth; the app also validates at the edge).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_scan_status_valid'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_scan_status_valid
      CHECK (scan_status IN ('pending', 'clean', 'infected', 'error'));
  END IF;
END $$;

-- Backfill pre-existing (non-archived) docs as clean — they pre-date the
-- scanner and must stay downloadable.
UPDATE documents
  SET scan_status = 'clean'
  WHERE scan_status = 'pending'
    AND archived_at IS NULL
    AND uploaded_at IS NOT NULL;

-- Partial index: the download/list paths filter on the gating verdict.
CREATE INDEX IF NOT EXISTS idx_documents_scan_status
  ON documents (scan_status)
  WHERE archived_at IS NULL;
