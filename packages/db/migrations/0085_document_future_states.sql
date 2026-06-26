-- 0085: document future-states — legal/version/validity/notary/phase columns
-- on `documents` (Slice 2.6; the third future-states entity, mirroring 2.5
-- owner_states / 2.7 apartment_states but as ADDITIVE COLUMNS on the existing
-- `documents` table, not a new table).
--
-- Spec: docs/MASTER-DISPATCH-BRIEF.md §1b / §2.6. A document grows a small set
-- of legal/life-cycle state fields so the system can perceive an at-risk or
-- legally-invalid required document (expired, rejected, superseded) and so the
-- `doc-expiry-warn` recommender can propose a follow-up task before a required
-- doc lapses.
--
-- ── PURELY ADDITIVE + BACKFILL-SAFE (the load-bearing rule) ─────────────────
-- EVERY column is NULLABLE with NO DEFAULT. A pre-existing row keeps every new
-- column NULL, and the sharpened `detectMissingRequiredDocs` treats NULL as
-- "not invalidating" (NULL legal_status ≠ 'rejected'; NULL valid_until ⇒ not
-- expired; NULL/absent version_state ≠ 'superseded'). So with all-NULL existing
-- rows the detection behaviour is BYTE-IDENTICAL to before this migration —
-- there is no semantic change to any existing document, no backfill needed, and
-- nothing for a seeder to set. This is the deliberate no-regression design.
--
-- ── NO PII ─────────────────────────────────────────────────────────────────
-- Every column is a closed taxonomy enum or a timestamp about the DOCUMENT's
-- legal lifecycle — never owner national_id / phone / name. `superseded_by_
-- document_id` is an opaque document uuid. No pgcrypto, no person columns.
--
-- Reversibility: HIGH. DROP the five (six incl. notarized_at + superseded_by)
-- columns + the partial index + the three enum types restores the prior state
-- exactly (no existing column was touched, no data rewritten).
-- Idempotent/guarded so a concurrent test-worker migrate() is safe.

-- ════════════════════ enum types (closed sets) ══════════════════════════
DO $$ BEGIN
  CREATE TYPE "public"."document_legal_status" AS ENUM('draft', 'reviewed', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."document_version_state" AS ENUM('current', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."document_notary_status" AS ENUM('none', 'required', 'notarized');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."document_relevant_phase" AS ENUM('planning', 'signatures', 'permit', 'construction', 'completion');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ════════════════════ columns (additive, ALL NULLABLE, NO DEFAULT) ═══════
-- legal_status — the doc's legal-review lifecycle. NULL = not-yet-classified
-- (the legacy state of every existing doc); the sharpened detection treats a
-- NULL legal_status as "not rejected" (i.e. it can satisfy a requirement).
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS legal_status "document_legal_status";

-- version_state — current vs superseded (a re-issued/replaced doc). NULL =
-- treated as 'current' (existing docs). superseded_by_document_id points at the
-- replacement; ON DELETE SET NULL (deleting the replacement must not destroy
-- this doc nor block the delete — the pointer just clears).
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS version_state "document_version_state";

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS superseded_by_document_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'documents_superseded_by_document_id_fk'
      AND table_name = 'documents'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_superseded_by_document_id_fk
      FOREIGN KEY (superseded_by_document_id) REFERENCES documents(id) ON DELETE SET NULL;
  END IF;
END $$;

-- valid_until — the legal validity horizon of the doc (e.g. a שומה / appraisal
-- or a permit that lapses). NULL = no known expiry (existing docs / docs that
-- do not expire). timestamptz (UTC stored; Asia/Jerusalem displayed).
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS valid_until timestamptz;

-- notary_status — whether the doc needs / has notarisation (אימות נוטריוני).
-- NULL = not-applicable/unknown. notarized_at stamps the notarisation moment.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS notary_status "document_notary_status";

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS notarized_at timestamptz;

-- relevant_phase — which renewal phase this doc belongs to (planning →
-- completion). NULL = unassigned. Pure taxonomy.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS relevant_phase "document_relevant_phase";

-- ════════════════════ index ═════════════════════════════════════════════
-- Partial index over approved, non-archived docs — the working set the
-- doc-expiry-warn recommender + the perception counts scan (approved docs that
-- may be expiring). Matches the §2.6 spec's `WHERE legal_status='approved' AND
-- archived_at IS NULL`.
CREATE INDEX IF NOT EXISTS idx_documents_legal_approved
  ON documents (org_id, valid_until)
  WHERE legal_status = 'approved' AND archived_at IS NULL;
