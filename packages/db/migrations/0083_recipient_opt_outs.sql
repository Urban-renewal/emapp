-- 0083: recipient_opt_outs — the autonomy outbound CONSENT / OPT-OUT registry
-- (M2; #506 reminder-cadence red-team MEDIUM finding — "ConsentGate input is
-- hard-coded true").
--
-- ⚠️ RENUMBER-ON-MERGE: this slice is HELD for the owner's Gate-6 sign-off (it
-- adds a TABLE). On `main` at authoring time the max migration is 0081
-- (0080_proposals, 0081_outbound_ledger). The held PR #498 ALSO carries
-- 0080/0081-numbered migrations, and the merged autonomy work took 0080/0081
-- (and a 0082 may land before this). If ANY migration lands ahead of this one,
-- bump this file's number AND its meta/_journal.json `when` to stay STRICTLY
-- GREATER than the new max (packages/db/CLAUDE.md migration rule — a too-low
-- `when` is caught by the journal-integrity preflight, never silently skipped).
--
-- ── WHY THIS TABLE (M2 — close the hard-coded-consent seam) ──────────────────
-- The OutboundGovernor's ConsentGate is the per-recipient opt-out gate on the
-- autonomous reminder path. Until now its `recipientConsented` input was a
-- hard-coded `true` (a documented seam): a recipient who asked to stop could
-- still be sent an autonomous reminder. This table is the durable registry the
-- gate now reads: a row here = "this recipient opted out of outbound on this
-- channel". The gate resolves (recipient, channel) against it and DENIES on a
-- match (or on `all`). Fail-closed: a lookup error denies (the caller treats an
-- unresolved consent as a non-send), it NEVER default-sends.
--
-- ── KEYED ON THE OWNER (the person), NOT the signature_request ───────────────
-- The outbound path's `recipient_ref` is the signature_request id, but an
-- opt-out is a property of the PERSON, not one request: a resident who opts out
-- must stop receiving reminders for EVERY pending request they hold, including
-- future ones. So the registry keys on owner_id. The ConsentGate resolves the
-- signature_request → its owner_id → this table. UNIQUE(org, owner, channel)
-- makes a re-opt-out idempotent (one durable row per owner+channel).
--
-- ── NO PII ───────────────────────────────────────────────────────────────────
-- We store ONLY the owner FK (an id) + channel + provenance. NEVER the raw
-- phone/email the opt-out came from — that is PII and lives encrypted on the
-- owner row. `source` is a generic enum (how the opt-out was recorded), never a
-- free-text address.
--
-- ── DURABLE (legal) — REVOKE DELETE ──────────────────────────────────────────
-- An opt-out is a legal record of a withdrawn consent: it must not be silently
-- erasable. app_user gets SELECT/INSERT/UPDATE only; DELETE is REVOKED. (A
-- re-opt-in, if ever built, flips a status/clears opted_out_at via UPDATE — it
-- does not DELETE the durable row.)
--
-- ── RLS posture (mirrors outbound_ledger/0081 + every tenant table) ──────────
-- FORCE + org-isolation on the `app.organization_id` GUC; the gate resolves +
-- the ingestion writes per-tenant inside withTenant(orgId, …). No app-path
-- BYPASSRLS read/write.
--
-- Reversibility: HIGH. DROP TABLE recipient_opt_outs (CASCADE) restores prior
-- state. Guarded/idempotent so a concurrent test-worker migrate() is safe.

CREATE TABLE IF NOT EXISTS recipient_opt_outs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- The recipient who opted out — the PERSON (owner), not a single signature
  -- request. The ConsentGate resolves a signature_request to its owner_id and
  -- checks this table. ON DELETE RESTRICT — an owner with a durable opt-out is
  -- never silently removed out from under the legal record.
  owner_id      uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  -- 'email' | 'sms' | 'all' (CHECK-pinned). 'all' opts the recipient out of
  -- EVERY channel; a per-channel row scopes the opt-out to one channel.
  channel       text NOT NULL,
  -- When the opt-out took effect. NULL is not allowed — a row's mere existence
  -- IS the opt-out; this is the durable timestamp of when it was recorded.
  opted_out_at  timestamptz NOT NULL DEFAULT now(),
  -- How the opt-out was recorded (provenance, NON-PII):
  --   'unsubscribe_link' — the recipient clicked an unsubscribe link,
  --   'manager'          — a manager/admin marked them opted-out,
  --   'provider_stop'    — an SMS/email provider STOP/complaint signal.
  source        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipient_opt_outs_channel_valid
    CHECK (channel IN ('email','sms','all')),
  CONSTRAINT recipient_opt_outs_source_valid
    CHECK (source IN ('unsubscribe_link','manager','provider_stop'))
);

-- ════════════════════ idempotent opt-out per owner+channel ══════════════════
-- At most ONE durable opt-out row per (org, owner, channel). A repeated opt-out
-- (clicking unsubscribe twice, a manager re-marking) is an idempotent UPSERT,
-- not a duplicate. ALSO the index the ConsentGate's resolution query rides:
-- "is there an opt-out for THIS (org, owner) on THIS channel or 'all'?" is a
-- cheap indexed lookup (no scan, no N+1).
CREATE UNIQUE INDEX IF NOT EXISTS recipient_opt_outs_org_owner_channel_unique
  ON recipient_opt_outs (org_id, owner_id, channel);

-- ════════════════════ RLS ═══════════════════════════════════════════════════
ALTER TABLE recipient_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipient_opt_outs FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'recipient_opt_outs'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON recipient_opt_outs
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ════════════════════ grants (no hard DELETE — opt-outs are durable) ═════════
GRANT SELECT, INSERT, UPDATE ON recipient_opt_outs TO app_user;
REVOKE DELETE ON recipient_opt_outs FROM app_user;
