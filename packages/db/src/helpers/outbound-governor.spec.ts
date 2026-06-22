/**
 * `OutboundGovernor` + M1 EXACTLY-ONCE — DB-backed acceptance tests
 * (Autonomous Master Plan, Phase 2; design correction M1).
 *
 * Covers the SLICE's required DB tests:
 *   - M1 exactly-once: a DOUBLE governed send on the SAME idempotency key
 *     (proposalId + recipient + cadenceStep) sends ONCE; the second is a no-op
 *     `already_sent` replay (never blind-resends). The `send` thunk's call count
 *     is the proof.
 *   - the gate pipeline DENIES before any send + ledger claim (kill-switch off).
 *   - a `failed` send settles the ledger row `failed` (the manager re-proposes a
 *     new step to retry).
 *   - RLS: the ledger row is org-scoped (a different org sees zero rows).
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

import { governOutboundSend, outboundIdempotencyKey } from './outbound-governor';

let orgA: string;
let orgB: string;
let proposalA: string;

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

function baseInput(send: () => Promise<{ delivered: boolean; providerMessageId?: string }>) {
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
    const send = async (): Promise<{ delivered: boolean; providerMessageId?: string }> => {
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
      proposalId: proposalA,
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
    const send = async (): Promise<{ delivered: boolean }> => {
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
      proposalId: proposalA,
      recipientRef: 'sigreq-killswitch',
      cadenceStep: 0,
    });
    const rows = await providerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbound_ledger
          WHERE org_id = ${orgA} AND idempotency_key = ${key}`,
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('settles the ledger FAILED when the send does not deliver', async () => {
    const send = async (): Promise<{ delivered: boolean }> => ({ delivered: false });
    const out = await governOutboundSend({
      ...baseInput(send),
      recipientRef: 'sigreq-fail',
    });
    expect(out.result).toBe('failed');

    const key = outboundIdempotencyKey({
      proposalId: proposalA,
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
