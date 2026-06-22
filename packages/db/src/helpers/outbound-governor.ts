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
 *      (proposal_id + recipient_ref + cadence_step) BEFORE sending — the M1
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

/** The send thunk the Governor calls on `allow` after claiming the ledger. It
 *  performs the ACTUAL provider send (the existing gated domain method). It MUST
 *  return whether at least one channel delivered + an opaque NON-PII message id. */
export interface OutboundSendResult {
  delivered: boolean;
  /** Opaque provider message id (NON-PII) for traceability. */
  providerMessageId?: string;
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
  /** The provider send failed — ledger row settled `failed`. */
  | { result: 'failed'; ledgerId: string; failureCode: string };

/** Compose the DETERMINISTIC idempotency key. The M1 root: same proposal +
 *  recipient + cadence step → same key → UNIQUE collision → no double-send. */
export function outboundIdempotencyKey(input: {
  proposalId: string;
  recipientRef: string;
  cadenceStep: number;
}): string {
  return `${input.proposalId}:${input.recipientRef}:${input.cadenceStep}`;
}

/**
 * Govern one outbound send: gates → exactly-once ledger claim → send → settle.
 *
 * Order of operations (the M1 guarantee):
 *   A. Pre-check: is there ALREADY a terminal `sent` row for this key? → no-op
 *      `already_sent` (cheap fast-path; the UNIQUE claim below is the real guard).
 *   B. Resolve the snapshot (recent-send counts) + evaluate the gates. A non-allow
 *      verdict → `blocked` with NO ledger row and NO send.
 *   C. CLAIM the ledger row: INSERT `pending_send` ON CONFLICT (org, idem_key) DO
 *      NOTHING. If the insert returns nothing, someone already owns the key —
 *      re-read it: a terminal `sent` → `already_sent`; a `pending_send` left by a
 *      crashed prior attempt → we do NOT blind-resend (return `already_sent`-class
 *      so a human can re-propose a new step if it truly never delivered). This is
 *      the exactly-once core: the UNIQUE constraint serializes concurrent claims.
 *   D. Call `send()` OUTSIDE the claim tx. On delivered → settle `sent`. On a
 *      throw/no-deliver → settle `failed` (the manager may re-propose a new step).
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
  // A leftover `pending_send` from a crashed attempt: do NOT blind-resend.
  if (prior && prior.status === 'pending_send') {
    return { result: 'already_sent', ledgerId: prior.id };
  }
  // A prior `failed` is NOT a blocker — a retry of the SAME step would collide on
  // the UNIQUE key (the claim below returns nothing), so a genuine retry must use
  // a NEW cadence step. We let the claim attempt proceed; it will no-op cleanly.

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

  const claimedRow = claimed[0];
  if (!claimedRow) {
    // Lost the claim race / a prior row owns the key. Re-read to classify.
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
      // sent / pending_send / failed — in every case we do NOT send: the key is
      // taken. `already_sent` is the safe exactly-once classification (a `failed`
      // owner means a genuine retry needs a NEW step).
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
    await settle(input.orgId, claimedRow.id, 'failed', { failureCode: 'send_threw' });
    return { result: 'failed', ledgerId: claimedRow.id, failureCode: 'send_threw' };
  }

  if (!sendResult.delivered) {
    await settle(input.orgId, claimedRow.id, 'failed', { failureCode: 'no_channel_delivered' });
    return { result: 'failed', ledgerId: claimedRow.id, failureCode: 'no_channel_delivered' };
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

/** Flip a claimed ledger row to a terminal state. Only a `pending_send` row is
 *  settled (race-safe — a concurrent settle is a no-op). */
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
