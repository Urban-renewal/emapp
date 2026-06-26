-- 0087: W-4.1 cross-party foundation — recipient capture on external_share +
-- the party_request (who-owes-what) obligation ledger.
--
-- ADDITIVE + BACKFILL-SAFE: every new external_share column is nullable (or has
-- a safe default); existing 0079 rows are untouched (their delivery_channel
-- defaults to 'manual_link', last_delivered_at stays NULL). The party_request
-- table is brand-new. Nothing here sends; the recipient cipher columns are
-- written ONLY by the service via pgcrypto (PII_ENCRYPTION_KEY).
--
-- RENUMBER-ON-MERGE NOTE: 0083–0086 are reserved by unmerged owner-gated PRs +
-- the 2.4–2.7 state-lane. This slice claims 0087 (when strictly > 0082). If any
-- 008x lands first, renumber this file + its meta/_journal.json entry so `when`
-- stays strictly increasing.
--
-- This migration:
--   1. ALTER external_share — add recipient_name, recipient_email_encrypted,
--      recipient_phone_encrypted (bytea, pgcrypto), delivery_channel enum
--      (default manual_link), last_delivered_at.
--   2. CREATE TYPE external_share_delivery_channel + party_request_status
--      (guarded — idempotent under concurrent test-worker migrate()).
--   3. CREATE TABLE party_request (org-scoped; project CASCADE; document_party
--      tolerant-text + CHECK; status lifecycle; partial-unique live obligation).
--   4. RLS FORCE + tenant_isolation on both new surfaces; GRANTs to app_user
--      (SELECT/INSERT/UPDATE; REVOKE DELETE — cancel is a status transition).
--
-- Reversibility: HIGH. DROP TABLE party_request; DROP TYPE party_request_status;
-- ALTER external_share DROP the five columns; DROP TYPE
-- external_share_delivery_channel. Guarded/idempotent.

-- ════════════════════ enum types (guarded) ══════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'external_share_delivery_channel') THEN
    CREATE TYPE external_share_delivery_channel AS ENUM ('email', 'sms', 'manual_link');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'party_request_status') THEN
    CREATE TYPE party_request_status AS ENUM ('open', 'delivered', 'fulfilled', 'cancelled');
  END IF;
END;
$$;

-- ════════════════════ external_share — recipient capture ════════════════════
-- All additive + nullable (delivery_channel has a safe default). IF NOT EXISTS
-- so a concurrent test-worker migrate() is a no-op.
ALTER TABLE external_share
  ADD COLUMN IF NOT EXISTS recipient_name             text,
  ADD COLUMN IF NOT EXISTS recipient_email_encrypted  bytea,
  ADD COLUMN IF NOT EXISTS recipient_phone_encrypted  bytea,
  ADD COLUMN IF NOT EXISTS delivery_channel           external_share_delivery_channel
    NOT NULL DEFAULT 'manual_link',
  ADD COLUMN IF NOT EXISTS last_delivered_at          timestamptz;

-- ════════════════════ party_request ═════════════════════════════════════════
CREATE TABLE IF NOT EXISTS party_request (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Direct org_id isolation key (documents-style). RLS gates by the
  -- app.organization_id GUC below.
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- The project the obligation belongs to. CASCADE on hard project removal.
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- One of the 9 DOCUMENT_PARTY_VALUES (binder axis). Tolerant text written
  -- from the Zod validator at the edge; the CHECK below is belt-and-braces so a
  -- raw SQL writer can never persist an off-vocabulary party.
  document_party        text NOT NULL,

  -- The doc type still owed (tolerant text — binder type vocabulary).
  requested_doc_type    text,

  status                party_request_status NOT NULL DEFAULT 'open',

  -- The grant minted to satisfy the obligation (4.2/4.3). SET NULL so revoking
  -- a share never orphans the obligation row.
  external_share_id     uuid REFERENCES external_share(id) ON DELETE SET NULL,

  -- The document that fulfilled it (4.3 write-back). SET NULL on doc removal.
  fulfilled_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  fulfilled_at          timestamptz,

  -- Provenance — the manager (or, later, the system) that opened the obligation.
  created_by            uuid REFERENCES users(id),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT party_request_document_party_valid
    CHECK (document_party IN (
      'owner','appraiser','architect','municipality','contractor',
      'lawyer','supervisor','surveyor','other'
    ))
);

-- The who-owes board feed: live obligations per org, attention-first.
CREATE INDEX IF NOT EXISTS idx_party_request_org_live
  ON party_request (org_id, created_at DESC, id DESC)
  WHERE status IN ('open','delivered');

-- Per-project drill-down.
CREATE INDEX IF NOT EXISTS idx_party_request_org_project
  ON party_request (org_id, project_id);

-- ONE live obligation per (org, project, party, doc-type). A fulfilled /
-- cancelled row releases the slot. NULL requested_doc_type is a distinct slot
-- per Postgres NULL semantics (a project may have one "any doc from party X"
-- obligation alongside typed ones — acceptable; the service uses typed asks).
CREATE UNIQUE INDEX IF NOT EXISTS party_request_live_unique
  ON party_request (org_id, project_id, document_party, requested_doc_type)
  WHERE status IN ('open','delivered');

-- ─── RLS (direct org_id — COPIED from external_share, migration 0079) ────────
ALTER TABLE party_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_request FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'party_request'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON party_request
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ─── grants (no DELETE on app_user; cancel is a status transition) ───────────
GRANT SELECT, INSERT, UPDATE ON party_request TO app_user;
REVOKE DELETE ON party_request FROM app_user;
