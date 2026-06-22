/**
 * `OutboundGovernor` — orchestrates the gate pipeline + the M1 exactly-once
 * ledger around EVERY governed outbound send (Autonomous Master Plan, Phase 2;
 * design corrections M1 + H-solid).
 *
 * The Governor is deliberately THIN (H-solid: "not a god-object"). It does FOUR
 * things and nothing else:
 *   1. RESOLVE the DB-backed snapshot the pure gates need (kill-switch flag,
 *      recipient consent, recent-send counts, breaker state).
 *   2. EVALUATE the pure gate pipeline (`evaluateOutboundPolicy`) — the RULES
 *      live in `@emapp/jobs/outbound-policy`, not here.
 *   3. CLAIM the `outbound_ledger` row by the DETERMINISTIC idempotency key
 *      (recipient_ref + cadence_step — STABLE across re-proposals; proposal_id is
 *      a non-key causal column) BEFORE sending — the M1
 *      exactly-once gate. A prior terminal `sent` on the key → NO-OP replay
 *      (never blind-resend). The claim is an INSERT … ON CONFLICT DO NOTHING on
 *      the UNIQUE key; losing the claim means someone else already owns this send.
 *   4. CALL the injected `send` thunk (the EXISTING gated domain method — the
 *      Governor never embeds send logic) and SETTLE the row (`sent`/`failed`).
 *
 * The actual provider call is the caller's `send` thunk. This is the seam that
 * lets the reminder executor REUSE the existing `resend`/`deliverResendPayload`
 * path verbatim — the Governor adds governance + exactly-once AROUND it, it does
 * not re-implement the send.
 *
 * Runs inside the caller's `withTenant(orgId, …)` for the ledger writes (RLS).
 * The `send` thunk runs OUTSIDE the ledger-claim tx (a slow/failing provider must
 * never hold a DB tx open) — the claim commits first, then we send, then we settle.
 */
import {
  evaluateOutboundPolicy,
  type OutboundGate,
  type OutboundPolicyConfig,
  type OutboundPolicyDecision,
  type OutboundRequest,
  type OutboundSnapshot,
  DEFAULT_OUTBOUND_GATES,
  DEFAULT_OUTBOUND_POLICY_CONFIG,
} from '@emapp/jobs';
import { and, eq, gte, sql } from 'drizzle-orm';

import { outboundLedger, type OutboundChannel } from '../schema/outbound-ledger';
import { withTenant } from '../wrappers/with-tenant';

/** The window (ms) over which the RateCeilingGate counts recent sends. */
export const OUTBOUND_RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Why a non-delivery is classified — the RETRYABLE-vs-AMBIGUOUS axis (H1 fix,
 * #506). A reminder send is real SMS/money: the ONLY safe failure semantics are:
 *
 *   - `definite`  — the provider STRUCTURALLY rejected the send (invalid number,
 *                   malformed payload) or nothing was even attempted (no channel
 *                   available). The message provably did NOT go out, so re-sending
 *                   the SAME step is correct (not a duplicate). Settled `failed`,
 *                   which the Governor can RE-CLAIM on the next approve.
 *   - `ambiguous` — the provider call THREW / timed out / network-errored. The SMS
 *                   may have ACTUALLY gone out, so re-sending = DOUBLE-SEND. Settled
 *                   `pending_send` (NOT `failed`) so it is NEVER blind-resent; the
 *                   existing pending_send→already_sent guard then protects it. A
 *                   human disambiguates (provider dashboard) before any re-send.
 *
 * When the caller cannot distinguish, it MUST default to `ambiguous` (the SAFE
 * side — never auto-resend). M1 exactly-once is sacred on this path.
 */
export type OutboundFailureKind = 'definite' | 'ambiguous';

/** The send thunk the Governor calls on `allow` after claiming the ledger. It
 *  performs the ACTUAL provider send (the existing gated domain method). It MUST
 *  return whether at least one channel delivered + an opaque NON-PII message id.
 *  On `delivered:false` it SHOULD classify the failure (`failureKind`); absent a
 *  classification the Governor treats it as `ambiguous` (the SAFE default — never
 *  auto-resend). */
export interface OutboundSendResult {
  delivered: boolean;
  /** Opaque provider message id (NON-PII) for traceability. */
  providerMessageId?: string;
  /** Why the send did not deliver (only meaningful when `delivered:false`). A
   *  `definite` non-send is re-claimable; an `ambiguous` one is parked. Absent →
   *  treated as `ambiguous`. */
  failureKind?: OutboundFailureKind;
  /** A generic NON-PII failure code for the ledger (e.g. 'sms_rejected'). */
  failureCode?: string;
}
export type OutboundSendThunk = () => Promise<OutboundSendResult>;

/** Everything the Governor needs to govern one send. */
export interface GovernedSendInput {
  orgId: string;
  /** The proposal whose APPROVE drives this send (idempotency key component). */
  proposalId: string;
  channel: OutboundChannel;
  /** NON-PII recipient discriminator (the signature_request id). */
  recipientRef: string;
  cadenceStep: number;
  /** Whether the recipient is consented (resolved by the caller from the owner
   *  record / future opt-out registry). Absent registry → true. */
  recipientConsented: boolean;
  /** The CAMPAIGN_SEND_ENABLED kill-switch state (resolved from env by caller). */
  killSwitchEnabled: boolean;
  /** Whether the org's outbound breaker is tripped (resolved by caller). */
  breakerTripped: boolean;
  /** The ACTUAL send (the existing gated method). Called only on `allow` + a
   *  fresh ledger claim. */
  send: OutboundSendThunk;
  /** Injected clock (deterministic in tests). */
  now: Date;
  /** Optional config + gate-list overrides (tests inject these). */
  config?: OutboundPolicyConfig;
  gates?: readonly OutboundGate[];
  /** Optional rate window override (tests). */
  rateWindowMs?: number;
}

/** The outcome of a governed send attempt. NO PII. */
export type GovernedSendOutcome =
  | { result: 'sent'; ledgerId: string; providerMessageId?: string }
  /** A prior terminal `sent` on the key → exactly-once no-op replay. */
  | { result: 'already_sent'; ledgerId: string }
  /** A gate denied/deferred the send — NO ledger row claimed, NO send. */
  | { result: 'blocked'; decision: OutboundPolicyDecision }
  /** A DEFINITE non-send (provider rejection / nothing attempted) — ledger row
   *  settled `failed` (RE-CLAIMABLE: the next approve re-claims + re-sends the
   *  SAME step, because the message provably did not go out). */
  | { result: 'failed'; ledgerId: string; failureCode: string }
  /** An AMBIGUOUS failure (provider threw / timed out): the send MAY have gone
   *  out, so it is NEVER auto-resent. The ledger row is settled `pending_send`
   *  (parked) and the existing pending_send→already_sent guard protects it; a
   *  human disambiguates before any re-send. Distinct from `failed` so the caller
   *  surfaces "needs manual check", not a false success and not a clean retry. */
  | { result: 'ambiguous'; ledgerId: string; failureCode: string };

/** Compose the DETERMINISTIC idempotency key. The M1 root: same recipient +
 *  cadence step → same key → UNIQUE collision → no double-send.
 *
 *  ── Why `proposalId` is DELIBERATELY NOT in the key (round-2 red-team fix) ────
 *  The exactly-once UNIT is "one send per (org, recipient, cadence-step)" —
 *  NOT "per proposal". The `org_id` half of `UNIQUE(org_id, idempotency_key)`
 *  supplies the org scope. If `proposalId` were in the key, a re-PROPOSAL of the
 *  SAME (recipient, step) — which happens whenever an AMBIGUOUS send parks a
 *  `pending_send` row and the original proposal then leaves `pending` via REJECT
 *  ("rejecting releases the dedup key so the condition can re-propose") or EXPIRE
 *  (recommender TTL) — would mint a NEW proposal P2 with a DIFFERENT key
 *  (`P2:R:0` ≠ the parked `P1:R:0`). P2's claim would NOT collide → a SECOND real
 *  SMS for a message that may already have dispatched. Keying on
 *  `recipientRef:cadenceStep` makes P2's claim COLLIDE with P1's parked row → the
 *  post-claim guard returns `already_sent` → no second send. The parked-ambiguous
 *  row correctly blocks ALL re-proposals of the same recipient+step. (`proposal_id`
 *  is still recorded as a NON-KEY causal column on the row for audit/trace —
 *  which proposal triggered the send — it is just not part of the key string.) */
export function outboundIdempotencyKey(input: {
  recipientRef: string;
  cadenceStep: number;
}): string {
  return `${input.recipientRef}:${input.cadenceStep}`;
}

/**
 * Govern one outbound send: gates → exactly-once ledger claim → send → settle.
 *
 * Order of operations (the M1 guarantee):
 *   A. Pre-check: is there ALREADY a terminal `sent` row for this key? → no-op
 *      `already_sent` (cheap fast-path; the UNIQUE claim below is the real guard).
 *   B. Resolve the snapshot (recent-send counts) + evaluate the gates. A non-allow
 *      verdict → `blocked` with NO ledger row and NO send.
 *   C. CLAIM the ledger row. TWO atomic primitives, tried in order:
 *        C1. INSERT `pending_send` ON CONFLICT (org, idem_key) DO NOTHING — the
 *            FIRST attempt for this key.
 *        C2. If the insert claimed nothing, an UPDATE … SET status='pending_send'
 *            WHERE status='failed' RETURNING — RE-CLAIM a prior DEFINITE-failed
 *            row (#506 H1 fix). A `failed` row means the message provably did NOT
 *            go out, so re-claiming + re-sending the SAME step is correct, not a
 *            double-send. The `WHERE status='failed'` makes it atomic: two
 *            concurrent retries → exactly ONE wins the UPDATE, the other re-reads
 *            and sees a non-`failed` owner → `already_sent` (no second send).
 *      If NEITHER claimed, re-read: a terminal `sent` → `already_sent`; a
 *      `pending_send` (live claim, crashed attempt, OR a parked AMBIGUOUS failure)
 *      → we do NOT blind-resend (`already_sent`-class). The UNIQUE constraint +
 *      the status-guarded UPDATE serialize concurrent claims = exactly-once.
 *   D. Call `send()` OUTSIDE the claim tx. On delivered → settle `sent`. On a
 *      DEFINITE non-send (provider rejection / nothing attempted) → settle `failed`
 *      (RE-CLAIMABLE next approve). On an AMBIGUOUS failure (provider threw/timed
 *      out — the SMS may have gone out) → settle `pending_send` (PARKED, never
 *      auto-resent; surfaced for manual handling).
 */
export async function governOutboundSend(input: GovernedSendInput): Promise<GovernedSendOutcome> {
  const config = input.config ?? DEFAULT_OUTBOUND_POLICY_CONFIG;
  const gates = input.gates ?? DEFAULT_OUTBOUND_GATES;
  const rateWindowMs = input.rateWindowMs ?? OUTBOUND_RATE_WINDOW_MS;
  const idempotencyKey = outboundIdempotencyKey(input);
  const windowStart = new Date(input.now.getTime() - rateWindowMs);

  const request: OutboundRequest = {
    orgId: input.orgId,
    channel: input.channel,
    recipientRef: input.recipientRef,
    cadenceStep: input.cadenceStep,
  };

  // ── (A) Fast-path exactly-once: a terminal `sent` row already exists. ──────
  const existing = await withTenant(input.orgId, (tx) =>
    tx
      .select({ id: outboundLedger.id, status: outboundLedger.status })
      .from(outboundLedger)
      .where(
        and(
          eq(outboundLedger.orgId, input.orgId),
          eq(outboundLedger.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1),
  );
  const prior = existing[0];
  if (prior && prior.status === 'sent') {
    return { result: 'already_sent', ledgerId: prior.id };
  }
  // A leftover `pending_send`: do NOT blind-resend. This covers BOTH a crashed
  // in-flight attempt AND a PARKED ambiguous failure (provider threw/timed out —
  // the send may have actually gone out). Either way re-sending risks a double-
  // send, so this is the exactly-once short-circuit. A human disambiguates a
  // parked row out-of-band; the autonomous path never auto-resends it.
  if (prior && prior.status === 'pending_send') {
    return { result: 'already_sent', ledgerId: prior.id };
  }
  // A prior `failed` is RE-CLAIMABLE (#506 H1): a `failed` row is a DEFINITE
  // non-send (provider rejection / nothing attempted), so the message provably
  // did not go out and re-sending the SAME step is correct, not a duplicate. We
  // do NOT short-circuit here — the status-guarded UPDATE in (C) re-claims it
  // atomically. (Pre-fix this returned `already_sent`, permanently killing the
  // step + falsely reporting success — the H1 defect.)

  // ── (B) Resolve snapshot + evaluate the pure gate pipeline. ────────────────
  const counts = await withTenant(input.orgId, async (tx) => {
    const [recipientRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outboundLedger)
      .where(
        and(
          eq(outboundLedger.orgId, input.orgId),
          eq(outboundLedger.recipientRef, input.recipientRef),
          eq(outboundLedger.status, 'sent'),
          gte(outboundLedger.createdAt, windowStart),
        ),
      );
    const [orgRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outboundLedger)
      .where(
        and(
          eq(outboundLedger.orgId, input.orgId),
          eq(outboundLedger.status, 'sent'),
          gte(outboundLedger.createdAt, windowStart),
        ),
      );
    return {
      recipientSendsInWindow: recipientRow?.n ?? 0,
      orgSendsInWindow: orgRow?.n ?? 0,
    };
  });

  const snapshot: OutboundSnapshot = {
    killSwitchEnabled: input.killSwitchEnabled,
    recipientConsented: input.recipientConsented,
    recipientSendsInWindow: counts.recipientSendsInWindow,
    orgSendsInWindow: counts.orgSendsInWindow,
    breakerTripped: input.breakerTripped,
  };

  const decision = evaluateOutboundPolicy(request, { now: input.now, snapshot, config }, gates);
  if (decision.verdict !== 'allow') {
    return { result: 'blocked', decision };
  }

  // ── (C) CLAIM the ledger row (the M1 exactly-once gate). ───────────────────
  // (C1) FIRST-ATTEMPT claim: INSERT pending_send ON CONFLICT DO NOTHING.
  const claimed = await withTenant(input.orgId, (tx) =>
    tx
      .insert(outboundLedger)
      .values({
        orgId: input.orgId,
        proposalId: input.proposalId,
        channel: input.channel,
        recipientRef: input.recipientRef,
        cadenceStep: input.cadenceStep,
        idempotencyKey,
        status: 'pending_send',
      })
      .onConflictDoNothing({
        target: [outboundLedger.orgId, outboundLedger.idempotencyKey],
      })
      .returning({ id: outboundLedger.id }),
  );

  let claimedRow = claimed[0];
  if (!claimedRow) {
    // (C2) RE-CLAIM a prior DEFINITE-failed row (#506 H1). Atomic: only ONE
    // concurrent retry can flip status='failed'→'pending_send'; the loser's
    // UPDATE matches nothing. This re-sends the SAME step (correct — the prior
    // attempt provably did not deliver) without ever risking a double-send.
    const reclaimed = await withTenant(input.orgId, (tx) =>
      tx
        .update(outboundLedger)
        .set({
          status: 'pending_send',
          settledAt: null,
          failureCode: null,
          providerMessageId: null,
        })
        .where(
          and(
            eq(outboundLedger.orgId, input.orgId),
            eq(outboundLedger.idempotencyKey, idempotencyKey),
            eq(outboundLedger.status, 'failed'),
          ),
        )
        .returning({ id: outboundLedger.id }),
    );
    claimedRow = reclaimed[0];
  }

  if (!claimedRow) {
    // Neither a fresh insert nor a failed-row re-claim succeeded. Re-read to
    // classify: the key is owned by a row we must NOT send over.
    const reread = await withTenant(input.orgId, (tx) =>
      tx
        .select({ id: outboundLedger.id, status: outboundLedger.status })
        .from(outboundLedger)
        .where(
          and(
            eq(outboundLedger.orgId, input.orgId),
            eq(outboundLedger.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1),
    );
    const owner = reread[0];
    if (owner) {
      // `sent` → exactly-once no-op. `pending_send` → a live claim, a crashed
      // attempt, OR a parked AMBIGUOUS failure — in every case we do NOT send.
      // (`failed` is no longer possible here: C2 would have re-claimed it; if a
      // concurrent retry flipped it to pending_send first, we correctly defer.)
      return { result: 'already_sent', ledgerId: owner.id };
    }
    // Extremely unlikely (claim returned nothing AND no row exists). Fail closed.
    return {
      result: 'blocked',
      decision: { verdict: 'deny', gate: 'ledger', reason: 'claim_lost' },
    };
  }

  // ── (D) SEND (outside the claim tx) + SETTLE. ──────────────────────────────
  let sendResult: OutboundSendResult;
  try {
    sendResult = await input.send();
  } catch {
    // The send thunk THREW — the provider call did not return a verdict, so the
    // SMS/email MAY have actually gone out (timeout/network mid-flight). This is
    // the canonical AMBIGUOUS case: settle `pending_send` (NOT `failed`) so it is
    // NEVER auto-resent; a human disambiguates before any re-send.
    return settleAmbiguous(input.orgId, claimedRow.id, 'send_threw');
  }

  if (!sendResult.delivered) {
    // A returned non-delivery: classify. `definite` (provider rejection /
    // nothing attempted) → `failed` (re-claimable next approve, a true non-send).
    // `ambiguous` OR unclassified → `pending_send` (parked, never auto-resent —
    // the SAFE default the contract mandates).
    const failureCode = sendResult.failureCode ?? 'no_channel_delivered';
    if (sendResult.failureKind === 'definite') {
      await settle(input.orgId, claimedRow.id, 'failed', { failureCode });
      return { result: 'failed', ledgerId: claimedRow.id, failureCode };
    }
    return settleAmbiguous(input.orgId, claimedRow.id, failureCode);
  }

  await settle(input.orgId, claimedRow.id, 'sent', {
    providerMessageId: sendResult.providerMessageId,
  });
  return {
    result: 'sent',
    ledgerId: claimedRow.id,
    providerMessageId: sendResult.providerMessageId,
  };
}

/** Flip a claimed ledger row to a TERMINAL state (`sent` or `failed`). Only a
 *  `pending_send` row is settled (race-safe — a concurrent settle is a no-op). A
 *  `failed` row stays re-claimable (the H1 fix); a `sent` row is the exactly-once
 *  no-op anchor. AMBIGUOUS failures are NOT settled here — they stay
 *  `pending_send` (see `settleAmbiguous`). */
async function settle(
  orgId: string,
  ledgerId: string,
  status: 'sent' | 'failed',
  extra: { providerMessageId?: string; failureCode?: string },
): Promise<void> {
  await withTenant(orgId, (tx) =>
    tx
      .update(outboundLedger)
      .set({
        status,
        settledAt: new Date(),
        providerMessageId: extra.providerMessageId ?? null,
        failureCode: extra.failureCode ?? null,
      })
      .where(and(eq(outboundLedger.id, ledgerId), eq(outboundLedger.status, 'pending_send'))),
  );
}

/** Park an AMBIGUOUS failure (provider threw / timed out — the send MAY have gone
 *  out). The row STAYS `pending_send` (NOT a terminal state) so the existing
 *  pending_send→already_sent guard makes it un-resendable by the autonomous path
 *  forever; we only stamp a NON-PII `failureCode` so a human can find +
 *  disambiguate it out-of-band. We deliberately do NOT set `settledAt` — the row
 *  is not terminal; it is parked pending human review. Race-safe: only flips a row
 *  still `pending_send`. */
async function settleAmbiguous(
  orgId: string,
  ledgerId: string,
  failureCode: string,
): Promise<GovernedSendOutcome> {
  await withTenant(orgId, (tx) =>
    tx
      .update(outboundLedger)
      .set({ failureCode })
      .where(and(eq(outboundLedger.id, ledgerId), eq(outboundLedger.status, 'pending_send'))),
  );
  return { result: 'ambiguous', ledgerId, failureCode };
}
