/**
 * `OutboundGovernor` + M1 EXACTLY-ONCE — DB-backed acceptance tests
 * (Autonomous Master Plan, Phase 2; design correction M1).
 *
 * Covers the SLICE's required DB tests:
 *   - M1 exactly-once: a DOUBLE governed send on the SAME idempotency key
 *     (recipientRef + cadenceStep — NOT proposalId) sends ONCE; the second is a
 *     no-op `already_sent` replay (never blind-resends). The `send` thunk's call
 *     count is the proof.
 *   - CROSS-PROPOSAL exactly-once (round-2 red-team regression): a parked
 *     AMBIGUOUS send on proposal P1, then a SECOND proposal P2 for the SAME
 *     (recipient, step) — P2's approve returns `already_sent`, NO second send.
 *     This is the regression that the proposalId-in-key bug would have failed.
 *   - the gate pipeline DENIES before any send + ledger claim (kill-switch off).
 *   - a DEFINITE `failed` send settles the ledger row `failed`.
 *   - RLS: the ledger row is org-scoped (a different org sees zero rows).
 *
 * #506 H1 — failed-send is RETRYABLE without double-send:
 *   - a DEFINITE-failed step is RE-CLAIMED on the next approve → EXACTLY ONE
 *     re-send (not permanently dead, not a double-send).
 *   - an AMBIGUOUS failure (provider threw/timed out) is settled `pending_send`
 *     (PARKED) and is NEVER auto-resent (the pending_send→already_sent guard).
 *   - two CONCURRENT retries of a failed step yield EXACTLY ONE re-send.
 *   - a definite-failed step reports `failed` (NOT a false `already_sent`/success).
 *
 * Seeding is BYPASSRLS (`providerDb`) — the proposals.spec template. The Governor
 * itself runs inside `withTenant` (RLS-scoped) exactly as on the real path.
 *
 * Run (needs a DB + Infisical):
 *   infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/outbound-governor.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../client';
import { organizations, outboundLedger } from '../schema/index';
import { withTenant } from '../wrappers/with-tenant';

import {
  governOutboundSend,
  outboundIdempotencyKey,
  type OutboundSendResult,
} from './outbound-governor';

type SendThunk = () => Promise<OutboundSendResult>;

let orgA: string;
let orgB: string;
let proposalA: string;
let proposalB: string;

const NOW = new Date('2026-06-22T12:00:00.000Z'); // daytime Jerusalem (allows quiet-hours)

async function seedOrg(tag: string): Promise<string> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `gov-${tag}-${orgId.slice(0, 8)}`,
    slug: `gov${tag}${orgId.slice(0, 8)}`.toLowerCase(),
  });
  return orgId;
}

/** Seed a pending proposal so the ledger FK (proposal_id) resolves. */
async function seedProposal(orgId: string): Promise<string> {
  const res = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO proposals (org_id, kind, status, scope_type, scope_id, evidence, dedup_key)
    VALUES (${orgId}, 'reminder.send', 'pending', 'signature_request',
            ${randomUUID()}, '{}'::jsonb, ${`reminder.send:${randomUUID()}:0`})
    RETURNING id
  `);
  return res.rows[0]!.id;
}

function baseInput(send: SendThunk) {
  return {
    orgId: orgA,
    proposalId: proposalA,
    channel: 'email' as const,
    recipientRef: 'sigreq-1',
    cadenceStep: 0,
    recipientConsented: true,
    killSwitchEnabled: true,
    breakerTripped: false,
    now: NOW,
    send,
  };
}

async function cleanupLedger(orgId: string): Promise<void> {
  await providerDb
    .execute(sql`DELETE FROM outbound_ledger WHERE org_id = ${orgId}`)
    .catch(() => undefined);
}

beforeAll(async () => {
  orgA = await seedOrg('a');
  orgB = await seedOrg('b');
  proposalA = await seedProposal(orgA);
  // A SECOND proposal in the SAME org — the cross-proposal regression seeds it as
  // the "re-proposal" P2 of the same (recipient, step) after P1 leaves pending.
  proposalB = await seedProposal(orgA);
}, 120_000);

afterAll(async () => {
  for (const org of [orgA, orgB]) {
    await cleanupLedger(org);
    await providerDb
      .execute(sql`DELETE FROM proposals WHERE org_id = ${org}`)
      .catch(() => undefined);
    await providerDb
      .delete(organizations)
      .where(eq(organizations.id, org))
      .catch(() => undefined);
  }
});

describe('OutboundGovernor — M1 exactly-once', () => {
  it('sends ONCE and the SECOND approve on the same key is an already_sent no-op', async () => {
    let sendCalls = 0;
    const send: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: true, providerMessageId: `msg-${sendCalls}` };
    };

    const first = await governOutboundSend(baseInput(send));
    expect(first.result).toBe('sent');
    expect(sendCalls).toBe(1);

    // Double-approve / retry on the SAME (proposal, recipient, step) key.
    const second = await governOutboundSend(baseInput(send));
    expect(second.result).toBe('already_sent');
    // The crux: the provider was NOT called a second time.
    expect(sendCalls).toBe(1);

    // Exactly ONE ledger row for the key, terminal `sent`.
    const key = outboundIdempotencyKey({
      recipientRef: 'sigreq-1',
      cadenceStep: 0,
    });
    const rows = await providerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbound_ledger
          WHERE org_id = ${orgA} AND idempotency_key = ${key} AND status = 'sent'`,
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('DENIES before sending when the kill-switch is off (no ledger row, no send)', async () => {
    let sendCalls = 0;
    const send: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: true };
    };
    const out = await governOutboundSend({
      ...baseInput(send),
      recipientRef: 'sigreq-killswitch',
      killSwitchEnabled: false,
    });
    expect(out.result).toBe('blocked');
    if (out.result === 'blocked') expect(out.decision.reason).toBe('kill_switch_off');
    expect(sendCalls).toBe(0);

    const key = outboundIdempotencyKey({
      recipientRef: 'sigreq-killswitch',
      cadenceStep: 0,
    });
    const rows = await providerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbound_ledger
          WHERE org_id = ${orgA} AND idempotency_key = ${key}`,
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('settles the ledger FAILED on a DEFINITE non-delivery (provider rejection)', async () => {
    const send: SendThunk = async () => ({
      delivered: false,
      failureKind: 'definite',
      failureCode: 'provider_rejected',
    });
    const out = await governOutboundSend({
      ...baseInput(send),
      recipientRef: 'sigreq-fail',
    });
    expect(out.result).toBe('failed');

    const key = outboundIdempotencyKey({
      recipientRef: 'sigreq-fail',
      cadenceStep: 0,
    });
    const rows = await providerDb.execute<{ status: string }>(
      sql`SELECT status FROM outbound_ledger
          WHERE org_id = ${orgA} AND idempotency_key = ${key} LIMIT 1`,
    );
    expect(rows.rows[0]!.status).toBe('failed');
  });

  it('RLS — the ledger row is org-scoped (orgB sees zero of orgA rows)', async () => {
    // orgA already wrote rows above. Read under orgB's tenant context.
    const seen = await withTenant(orgB, (tx) =>
      tx.select({ id: outboundLedger.id }).from(outboundLedger),
    );
    // None of orgA's rows are visible under orgB's RLS context.
    expect(seen.length).toBe(0);
  });
});

describe('OutboundGovernor — #506 H1 failed-send retryable without double-send', () => {
  async function ledgerRow(orgId: string, key: string): Promise<{ status: string; n: number }> {
    const rows = await providerDb.execute<{ status: string; n: number }>(
      sql`SELECT status, count(*) OVER ()::int AS n FROM outbound_ledger
          WHERE org_id = ${orgId} AND idempotency_key = ${key} LIMIT 1`,
    );
    return rows.rows[0] ?? { status: 'NONE', n: 0 };
  }

  it('RE-CLAIMS a definite-failed step on the next approve → exactly ONE re-send', async () => {
    const recipientRef = 'sigreq-reclaim';
    const key = outboundIdempotencyKey({ recipientRef, cadenceStep: 0 });

    // Attempt 1: a DEFINITE failure → ledger settles `failed`, result `failed`.
    let sendCalls = 0;
    const failOnce: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: false, failureKind: 'definite', failureCode: 'provider_rejected' };
    };
    const first = await governOutboundSend({ ...baseInput(failOnce), recipientRef });
    expect(first.result).toBe('failed');
    expect(sendCalls).toBe(1);
    expect((await ledgerRow(orgA, key)).status).toBe('failed');

    // Attempt 2 (SAME key — the recommender re-derives the SAME step because
    // reminders_sent counts only `sent`): the failed row is RE-CLAIMED and the
    // send actually goes out this time → `sent`, exactly ONE additional call.
    const succeed: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: true, providerMessageId: 'msg-retry' };
    };
    const second = await governOutboundSend({ ...baseInput(succeed), recipientRef });
    expect(second.result).toBe('sent');
    expect(sendCalls).toBe(2); // re-claimed + re-sent ONCE (not blind-resent, not dead)

    const after = await ledgerRow(orgA, key);
    expect(after.status).toBe('sent');
    expect(after.n).toBe(1); // STILL exactly one ledger row for the key (re-used, not duplicated)
  });

  it('PARKS an AMBIGUOUS failure as pending_send and NEVER auto-resends it', async () => {
    const recipientRef = 'sigreq-ambiguous';
    const key = outboundIdempotencyKey({ recipientRef, cadenceStep: 0 });

    // Attempt 1: an AMBIGUOUS failure (provider threw/timed out — may have gone
    // out). Result `ambiguous`; the row STAYS `pending_send` (parked), NOT failed.
    let sendCalls = 0;
    const ambiguous: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: false, failureKind: 'ambiguous', failureCode: 'provider_send_failed' };
    };
    const first = await governOutboundSend({ ...baseInput(ambiguous), recipientRef });
    expect(first.result).toBe('ambiguous');
    expect(sendCalls).toBe(1);
    expect((await ledgerRow(orgA, key)).status).toBe('pending_send');

    // Attempt 2: a re-approve must be a NO-OP `already_sent` (the parked
    // pending_send guard) — the provider is NEVER called again (no double-send).
    const wouldSend: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: true };
    };
    const second = await governOutboundSend({ ...baseInput(wouldSend), recipientRef });
    expect(second.result).toBe('already_sent');
    expect(sendCalls).toBe(1); // NEVER auto-resent — the crux
    expect((await ledgerRow(orgA, key)).status).toBe('pending_send'); // still parked
  });

  it('CROSS-PROPOSAL: a parked AMBIGUOUS on P1 blocks a NEW proposal P2 for the same (recipient, step) — NO second send', async () => {
    // The round-2 red-team gap. Scenario:
    //   1. P1 governs a send for (recipient, step 0) that AMBIGUOUSLY fails →
    //      the ledger row parks `pending_send` (may have actually gone out).
    //   2. P1 then leaves `pending` (REJECT releases the dedup key, or EXPIRE) and
    //      the recommender re-proposes the SAME (recipient, step) as a NEW
    //      proposal P2 (the parked row is `pending_send`, not `sent`, so the
    //      reminders_sent count stays 0 → same step still due).
    //   3. Approving P2 MUST NOT mint a second send. With proposalId IN the key,
    //      P2's key (`P2:R:0`) would NOT collide with the parked `P1:R:0` → a
    //      SECOND real SMS. With the key = recipientRef:cadenceStep, P2 COLLIDES
    //      with the parked row → already_sent → no second send. This asserts that.
    const recipientRef = 'sigreq-cross-proposal';
    let sendCalls = 0;

    // (1) P1 — AMBIGUOUS failure parks the row `pending_send`.
    const ambiguous: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: false, failureKind: 'ambiguous', failureCode: 'provider_send_failed' };
    };
    const p1 = await governOutboundSend({
      ...baseInput(ambiguous),
      proposalId: proposalA,
      recipientRef,
    });
    expect(p1.result).toBe('ambiguous');
    expect(sendCalls).toBe(1);

    const key = outboundIdempotencyKey({ recipientRef, cadenceStep: 0 });
    expect((await ledgerRow(orgA, key)).status).toBe('pending_send');

    // (2)+(3) P2 — a DIFFERENT proposal, SAME (recipient, step). Pre-fix this
    // would have minted `P2:R:0` and fired a SECOND send. Now it collides with the
    // parked `R:0` row → already_sent → the provider is NEVER called again.
    const wouldSend: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: true, providerMessageId: 'msg-p2' };
    };
    const p2 = await governOutboundSend({
      ...baseInput(wouldSend),
      proposalId: proposalB, // the re-proposal — a DIFFERENT proposal id
      recipientRef,
    });
    expect(p2.result).toBe('already_sent'); // the parked row blocks the re-proposal
    expect(sendCalls).toBe(1); // THE CRUX — no second real send across proposals

    // Still exactly ONE ledger row for the (recipient, step) key, still parked.
    const after = await ledgerRow(orgA, key);
    expect(after.status).toBe('pending_send');
    expect(after.n).toBe(1);
  });

  it('a send THAT THROWS is treated as AMBIGUOUS (parked, never auto-resent)', async () => {
    const recipientRef = 'sigreq-threw';
    const key = outboundIdempotencyKey({ recipientRef, cadenceStep: 0 });

    let sendCalls = 0;
    const thrower: SendThunk = async () => {
      sendCalls += 1;
      throw new Error('provider timeout');
    };
    const first = await governOutboundSend({ ...baseInput(thrower), recipientRef });
    expect(first.result).toBe('ambiguous');
    expect((await ledgerRow(orgA, key)).status).toBe('pending_send');

    // Re-approve never re-sends a parked throw.
    const second = await governOutboundSend({ ...baseInput(thrower), recipientRef });
    expect(second.result).toBe('already_sent');
    expect(sendCalls).toBe(1);
  });

  it('two CONCURRENT retries of a failed step yield EXACTLY ONE re-send', async () => {
    const recipientRef = 'sigreq-concurrent';
    const key = outboundIdempotencyKey({ recipientRef, cadenceStep: 0 });

    // Seed a `failed` row first (one definite-failed attempt).
    const failFirst: SendThunk = async () => ({
      delivered: false,
      failureKind: 'definite',
      failureCode: 'provider_rejected',
    });
    const seed = await governOutboundSend({ ...baseInput(failFirst), recipientRef });
    expect(seed.result).toBe('failed');

    // Two retries fire CONCURRENTLY. The status-guarded re-claim UPDATE is atomic:
    // exactly ONE wins (re-sends), the other sees a non-failed owner → already_sent.
    let sendCalls = 0;
    const succeed: SendThunk = async () => {
      sendCalls += 1;
      return { delivered: true, providerMessageId: `msg-${sendCalls}` };
    };
    const [a, b] = await Promise.all([
      governOutboundSend({ ...baseInput(succeed), recipientRef }),
      governOutboundSend({ ...baseInput(succeed), recipientRef }),
    ]);

    const results = [a.result, b.result];
    // The INVARIANT under concurrency: EXACTLY ONE retry wins the atomic
    // status-guarded re-claim and re-sends (`sent`); the other is a no-op that
    // does NOT re-send. The loser's LABEL is race-dependent — it is `already_sent`
    // if it observes the row already `sent`, or `blocked` if it observes the row
    // mid-claim (`pending_send`, owned by the winner) — both are correct no-ops.
    // Asserting one specific loser label made this test flaky; assert the real
    // invariant (one send, no double-send) instead.
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_sent' || r === 'blocked')).toHaveLength(1);
    expect(sendCalls).toBe(1); // EXACTLY ONE re-send under concurrency — M1 preserved

    const after = await ledgerRow(orgA, key);
    expect(after.status).toBe('sent');
    expect(after.n).toBe(1);
  });
});
