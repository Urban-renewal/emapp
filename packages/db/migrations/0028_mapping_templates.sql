-- 0028: mapping_templates table — D.34 Layer 2
--
-- Phase 6 S7 — the persistence side of the layered mapping seam.
--
-- Architecture (D.34):
--   Layer 1: deterministic alias match — `apps/worker/src/mapping/mapping.ts`
--            ~80% of common-shape files; pure CPU.
--   Layer 2: PER-ORG SAVED TEMPLATES — this table.
--            A manager who maps a custom-shape file once (via the
--            wizard, S8) saves the resolution. The next file with the
--            SAME fingerprint resolves instantly.
--   Layer 3: agent normalisation — Phase 7+. Sends ONLY headers
--            (never row content) to an LLM, proposes a mapping with
--            confidence, manager approves → becomes a Layer-2 row.
--
-- Fingerprint = sha256(headers.map(normaliseHeader).sort().join('|')).
-- Deterministic; same headers → same key. The worker computes the
-- fingerprint at parse time and looks up here.
--
-- Approval-required posture: source='agent' rows MUST have
-- approved_by set before the worker uses them. Manager-source rows
-- are auto-approved (approved_by = created_by). This prevents an LLM
-- hallucination from auto-applying to real PII imports.
--
-- RLS: org-direct, same pattern as projects / documents.
-- GRANT: no DELETE on app_user (forensic — like import_jobs).
--   A wrong mapping isn't "deleted"; it's archived via archived_at.

CREATE TABLE IF NOT EXISTS mapping_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- Stable fingerprint of the headers this template applies to.
  -- 64 hex chars (sha256). The worker computes this BEFORE looking up
  -- so the lookup is one indexed equality.
  fingerprint   text NOT NULL,

  -- Optional human label ("Tama-38 imports from Levi Construction").
  name          text,

  -- The resolved column mapping. Shape:
  --   { "columns": { "national_id": 0, "phone": 1, ... },
  --     "headers": ["ת.ז.", "טלפון", ...],  -- the EXACT input headers
  --                                            this fingerprint represents
  --                                            (for debugging + UX)
  --   }
  -- jsonb (not typed columns) is intentional: the canonical-field
  -- enum lives in code (apps/worker/src/mapping/mapping.ts
  -- CanonicalField). Adding a new canonical = code change + new
  -- migration to migrate existing rows would be heavy. jsonb is
  -- forward-compatible: a template with old keys still works; new
  -- keys appear naturally.
  mapping       jsonb NOT NULL,

  -- Provenance: where did this template come from?
  --   'manual'  — manager approved via wizard
  --   'agent'   — Phase 7+ LLM-proposed (REQUIRES approved_by before use)
  --   'system'  — preseeded by EMAPP (none today)
  source        text NOT NULL,

  -- Confidence in [0,100] when source='agent'; NULL otherwise.
  -- Worker MAY refuse low-confidence templates without manager
  -- approval (policy decision deferred to Phase 7).
  confidence    numeric(5, 2),

  created_by    uuid NOT NULL REFERENCES users(id),
  -- Worker MUST verify approved_by IS NOT NULL before using a template.
  -- 'manual' source rows are auto-approved at creation (the wizard sets
  -- approved_by = created_by); 'agent' rows are not.
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Soft-delete (Phase-6 / docs/02 convention — never hard-delete a
  -- mapping that was once used; a job audit may reference it).
  archived_at   timestamptz
);

-- source CHECK — fail-closed enum.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mapping_templates_source_valid'
      AND conrelid = 'mapping_templates'::regclass
  ) THEN
    ALTER TABLE mapping_templates
      ADD CONSTRAINT mapping_templates_source_valid
      CHECK (source IN ('manual', 'agent', 'system'));
  END IF;
END;
$$;

-- confidence range CHECK (agent only; NULL when source != 'agent').
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mapping_templates_confidence_range'
      AND conrelid = 'mapping_templates'::regclass
  ) THEN
    ALTER TABLE mapping_templates
      ADD CONSTRAINT mapping_templates_confidence_range
      CHECK (
        (source = 'agent' AND confidence IS NOT NULL AND confidence >= 0 AND confidence <= 100)
        OR (source <> 'agent' AND confidence IS NULL)
      );
  END IF;
END;
$$;

-- approval CHECK: approved_at and approved_by must move together.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mapping_templates_approval_paired'
      AND conrelid = 'mapping_templates'::regclass
  ) THEN
    ALTER TABLE mapping_templates
      ADD CONSTRAINT mapping_templates_approval_paired
      CHECK ((approved_by IS NULL) = (approved_at IS NULL));
  END IF;
END;
$$;

-- One template per (org, fingerprint, active). Partial unique allows
-- archiving + re-creating a fresh template for the same fingerprint.
CREATE UNIQUE INDEX IF NOT EXISTS mapping_templates_org_fp_active
  ON mapping_templates (org_id, fingerprint)
  WHERE archived_at IS NULL;

-- Indexed lookup for the manager UI's "all templates I can choose
-- from" query (S8 wizard).
CREATE INDEX IF NOT EXISTS idx_mapping_templates_org_recent
  ON mapping_templates (org_id, created_at DESC)
  WHERE archived_at IS NULL;

-- ════════════════════ RLS ════════════════════════════════════════════
ALTER TABLE mapping_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_templates FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mapping_templates'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON mapping_templates
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ════════════════════ grants ═════════════════════════════════════════
-- app_user: SELECT + INSERT + UPDATE (for soft-delete via archived_at).
-- No DELETE — a template that was ever used by an import_job is
-- forensic evidence. Provider-admin can hard-delete via BYPASSRLS.
GRANT SELECT, INSERT, UPDATE ON mapping_templates TO app_user;
REVOKE DELETE ON mapping_templates FROM app_user;
