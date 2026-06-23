-- 0081: outbound_ledger — the M1 EXACTLY-ONCE outbound spine (Autonomous Master
-- Plan, Phase 2; design correction M1).
--
-- ⚠️ RENUMBER-ON-MERGE: the held PR #498 ALSO introduces a 0080-numbered
-- migration. 0080_proposals is already committed on main, so this slice takes
-- the next free number 0081. If #498 lands first and renumbers, bump this file
-- + its meta/_journal.json `when` to stay strictly greater than the new max
-- (packages/db/CLAUDE.md migration rule — a too-low `when` is caught by
-- journal-integrity preflight, never silently skipped).
--
-- ── WHY THIS TABLE (M1 — "ledger before send" is NOT exactly-once) ───────────
-- Every governed outbound (a reminder email/SMS) carries a DETERMINISTIC
-- idempotency key = recipient_ref + cadence_step (org scope comes from the
-- (org_id, idempotency_key) UNIQUE; proposal_id is DELIBERATELY NOT in the key —
-- the exactly-once unit is per recipient+step, STABLE across re-proposals, so a
-- re-PROPOSAL of the same recipient+step collides with a parked row instead of
-- minting a second send). The UNIQUE constraint on that key + the explicit state
-- machine (pending_send → sent → failed) is the root fix for the duplicate-SMS
-- class: a double-approve, a retry-after-ambiguous-failure, OR a cross-proposal
-- re-propose CLAIMS the same key, finds a prior terminal `sent` (or a parked
-- `pending_send`), and no-ops the replay — it never blind-resends. "Write a
-- ledger row before sending" only gives attempt-durability; the UNIQUE key +
-- state machine is what guarantees exactly-once. Mirrors the proven `import_jobs`
-- idempotency_key UNIQUE idiom.
--
-- ── STATE MACHINE ───────────────────────────────────────────────────────────
--   pending_send  — the governor CLAIMED the key (row inserted) and is about to
--                   call the provider. A crash here leaves a claim that a later
--                   attempt re-reads (it does NOT re-send while pending unless it
--                   can prove the prior attempt did not deliver).
--   sent          — the provider acknowledged (sent/queued). TERMINAL success.
--                   A replay on this key is a no-op.
--   failed        — the provider rejected / errored. TERMINAL-ish: the manager
--                   may re-propose (a NEW cadence_step → a NEW key) to retry.
--
-- ── RLS posture (mirrors proposals/0080 + every tenant table) ────────────────
-- FORCE + org-isolation on the `app.organization_id` GUC. The governor writes
-- per-tenant inside withTenant(orgId, …); there is NO app-path BYPASSRLS
-- read/write. No physical DELETE on app_user (terminal states are status flips).
--
-- Reversibility: HIGH. DROP TABLE outbound_ledger (CASCADE) restores prior state.
-- Guarded/idempotent so a concurrent test-worker migrate() is safe.

CREATE TABLE IF NOT EXISTS outbound_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- The proposal whose APPROVE drove this send (the audit/causal link). A
  -- NON-KEY column — NOT part of the idempotency key (the key is stable across
  -- re-proposals; see the header). ON DELETE RESTRICT — a proposal with a ledger
  -- row is never silently removed.
  proposal_id   uuid NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  -- The channel the send went out on. Part of the idempotency key shaping the
  -- rate bucket; 'email' | 'sms' (CHECK-pinned).
  channel       text NOT NULL,
  -- The recipient discriminator component of the idempotency key. This is a
  -- STABLE, NON-PII handle — the signature_request id the reminder targets, NOT
  -- the owner's email/phone (which is PII and never stored here). The governor
  -- composes the key from ids only; the actual address is resolved at send time
  -- from the gated domain method and never persisted in the ledger.
  recipient_ref text NOT NULL,
  -- The cadence step (0/+3/+7/+14 → 0,1,2,3). A NEW step yields a NEW key, so a
  -- legitimate next-cadence reminder is a distinct send, while a retry of the
  -- SAME step collides on the UNIQUE key and is de-duplicated.
  cadence_step  integer NOT NULL,
  -- The DETERMINISTIC idempotency key = recipient_ref + cadence_step (composed
  -- string; NOT proposal_id — stable across re-proposals). UNIQUE per org. This
  -- is the M1 root.
  idempotency_key text NOT NULL,
  -- pending_send | sent | failed (CHECK-pinned). The state machine.
  status        text NOT NULL DEFAULT 'pending_send',
  -- Provider message id on success (NON-PII opaque handle), for traceability.
  provider_message_id text,
  -- Generic failure code on failure (NO PII, NO provider raw error text).
  failure_code  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when the row reaches a terminal state (sent/failed).
  settled_at    timestamptz,
  CONSTRAINT outbound_ledger_channel_valid
    CHECK (channel IN ('email','sms')),
  CONSTRAINT outbound_ledger_status_valid
    CHECK (status IN ('pending_send','sent','failed')),
  CONSTRAINT outbound_ledger_cadence_step_nonneg
    CHECK (cadence_step >= 0)
);

-- ════════════════════ M1 — the exactly-once UNIQUE ══════════════════════════
-- At most ONE ledger row per (org, idempotency_key), across ALL states. Unlike
-- the proposals partial-unique (which releases on non-pending), this is a FULL
-- unique: a terminal `sent` row MUST keep occupying the key so a replay collides
-- and no-ops instead of re-sending. Mirrors `import_jobs_idem_unique`.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_ledger_org_idem_unique
  ON outbound_ledger (org_id, idempotency_key);

-- Lookup by proposal (the executor checks "did this proposal already send?").
CREATE INDEX IF NOT EXISTS idx_outbound_ledger_org_proposal
  ON outbound_ledger (org_id, proposal_id);

-- Rate-ceiling windows scan recent rows per org/recipient (RateCeilingGate).
CREATE INDEX IF NOT EXISTS idx_outbound_ledger_org_recipient_created
  ON outbound_ledger (org_id, recipient_ref, created_at DESC);

-- ════════════════════ RLS ═══════════════════════════════════════════════════
ALTER TABLE outbound_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_ledger FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'outbound_ledger'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON outbound_ledger
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ════════════════════ grants (no hard DELETE on app_user) ═══════════════════
GRANT SELECT, INSERT, UPDATE ON outbound_ledger TO app_user;
REVOKE DELETE ON outbound_ledger FROM app_user;
