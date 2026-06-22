-- 0080: proposals — the Approval-Inbox SPINE (Autonomous Master Plan, Phase 1).
--
-- One org-scoped row per autonomous DRAFT awaiting a human's one-click confirm.
-- A recommender DETECTS a condition; the generic producer SNAPSHOTS evidence and
-- writes a `pending` proposal via `emitProposal()` (the single insert path, which
-- classifies the kind through AutonomyPolicy). The manager APPROVES (replay the
-- gated method, re-asserting the boundary at execute) or REJECTS it.
--
-- THE IDEMPOTENCY INVARIANT (the heart of the spine):
--   UNIQUE(org_id, dedup_key) WHERE status = 'pending'
-- A producer that runs twice (overlapping ticks / retry) cannot create two LIVE
-- proposals for one condition — the second emit is a no-op (ON CONFLICT DO
-- NOTHING in emitProposal). Once a proposal leaves `pending`, the partial index
-- releases the key so the SAME condition recurring later can re-propose. Mirrors
-- the proven `import_jobs.idempotency_key` UNIQUE idiom.
--
-- RLS posture: FORCE + org-isolation on the `app.organization_id` GUC, identical
-- to every other tenant table (see 0075/0077/0079). The only system writer (the
-- producer) still scopes per-org inside withTenant — there is NO app-path
-- BYPASSRLS read/write of proposals. No physical DELETE on app_user (terminal
-- states are status flips, never row removal — append-only-ish, audit-friendly).
--
-- Reversibility: HIGH. DROP TABLE proposals (CASCADE) restores the prior state.
-- Guarded/idempotent so a concurrent test-worker migrate() is safe.

CREATE TABLE IF NOT EXISTS proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- AutonomyPolicy action kind (e.g. 'signature_request.reissue'). emitProposal
  -- classifies it; an unknown kind throws before any insert.
  kind         text NOT NULL,
  -- pending | approved | rejected | expired | applied. CHECK-pinned below.
  status       text NOT NULL DEFAULT 'pending',
  -- What the proposal is ABOUT (project/owner/signature_request/…) + its id.
  scope_type   text NOT NULL,
  scope_id     uuid NOT NULL,
  -- Evidence SNAPSHOT taken at emit (NOT recomputed on read). ids/counts only —
  -- never PII (national_id/phone/name), enforced by the producer template layer.
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Deterministic idempotency key (partial-UNIQUE per org WHERE pending).
  dedup_key    text NOT NULL,
  -- Retires a stale pending proposal so the inbox never accumulates noise.
  expires_at   timestamptz,
  -- Always 'system' in Phase 1 — the engine authored this draft.
  actor_type   text NOT NULL DEFAULT 'system',
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Set when APPROVE successfully replays the gated domain method.
  applied_at   timestamptz,
  CONSTRAINT proposals_status_valid
    CHECK (status IN ('pending','approved','rejected','expired','applied')),
  -- Phase 1: the engine is the only author. Pinned so a stray writer can't claim
  -- a human/provider actor on a proposal row.
  CONSTRAINT proposals_actor_type_valid
    CHECK (actor_type IN ('system'))
);

-- The idempotency invariant — at most ONE live (pending) proposal per
-- (org, dedup_key). Releases the key once the proposal leaves pending.
CREATE UNIQUE INDEX IF NOT EXISTS proposals_org_dedup_pending_unique
  ON proposals (org_id, dedup_key)
  WHERE status = 'pending';

-- Inbox list / keyset pagination over pending proposals, newest first.
CREATE INDEX IF NOT EXISTS idx_proposals_org_pending
  ON proposals (org_id, created_at DESC, id DESC)
  WHERE status = 'pending';

-- The expiry sweep predicate (pending + past expires_at).
CREATE INDEX IF NOT EXISTS idx_proposals_pending_expiry
  ON proposals (expires_at)
  WHERE status = 'pending';

-- ════════════════════ RLS ═══════════════════════════════════════════════════
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'proposals'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON proposals
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ════════════════════ grants (no hard DELETE on app_user) ═══════════════════
GRANT SELECT, INSERT, UPDATE ON proposals TO app_user;
REVOKE DELETE ON proposals FROM app_user;
