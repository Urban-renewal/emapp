/**
 * PARKED-OUTBOUND ops service spec (Autonomous Master Plan — #509 observability
 * gap) — against the real local DB.
 *
 * Covers the slice's required DB tests:
 *   - list: surfaces PARKED-AMBIGUOUS (pending_send + failure_code NOT NULL) +
 *     STALE-CRASHED (pending_send + failure_code NULL + old), EXCLUDES a fresh
 *     in-flight claim, EXCLUDES terminal sent/failed. ?reason filter narrows.
 *   - count: returns the per-bucket counts.
 *   - NO PII: the wire shape carries only ids/channel/failure_code/created_at —
 *     never a phone/email/owner field (the row never has one anyway).
 *   - RLS cross-org isolation: org B cannot see / resolve org A's parked rows.
 *   - manager-only: a non-manager (viewer) is FORBIDDEN on every op.
 *   - resolve EXACTLY-ONCE safety:
 *       · resolve→sent flips the row TERMINAL `sent` (delivery no-op, the
 *         exactly-once anchor) — it does NOT re-claim / re-send.
 *       · resolve→failed flips the row TERMINAL `failed` → the governor CAN
 *         re-claim it (proven by the status being `failed`, the re-claimable
 *         state per the merged H1 logic).
 *       · the status guard: a non-`pending_send` row 409s (can't race a settle,
 *         can't double-resolve).
 *
 * Seeding is BYPASSRLS (`providerDb`) — the proposals/outbound-governor template.
 * The service runs inside withTenant (RLS-scoped) exactly as on the real path.
 *
 * Run (needs a DB + Infisical):
 *   infisical run --env dev -- pnpm --filter @emapp/api exec vitest run \
 *     src/modules/parked-outbound/parked-outbound.service.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { outboundLedger, providerDb } from '@emapp/db';
import { ForbiddenException, ConflictException, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ParkedOutboundService } from './parked-outbound.service';

let orgA: TestOrg;
let orgB: TestOrg;
let svc: ParkedOutboundService;

function manager(org: TestOrg): AccessTokenPayload {
  return {
    sub: org.users[0]!.id,
    orgId: org.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-000000000001',
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function viewer(org: TestOrg): AccessTokenPayload {
  return { ...manager(org), role: 'viewer' } as AccessTokenPayload;
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

/** Seed a ledger row directly (BYPASSRLS). `createdAt`/`failureCode`/`status`
 *  drive the bucket. Returns the row id. */
async function seedLedger(opts: {
  orgId: string;
  proposalId: string;
  recipientRef: string;
  cadenceStep?: number;
  status?: 'pending_send' | 'sent' | 'failed';
  failureCode?: string | null;
  createdAt?: Date;
  channel?: 'email' | 'sms';
}): Promise<string> {
  const cadenceStep = opts.cadenceStep ?? 0;
  const [row] = await providerDb
    .insert(outboundLedger)
    .values({
      orgId: opts.orgId,
      proposalId: opts.proposalId,
      channel: opts.channel ?? 'sms',
      recipientRef: opts.recipientRef,
      cadenceStep,
      idempotencyKey: `${opts.recipientRef}:${cadenceStep}`,
      status: opts.status ?? 'pending_send',
      failureCode: opts.failureCode ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: outboundLedger.id });
  return row!.id;
}

async function readLedger(id: string): Promise<{ status: string; settledAt: Date | null } | null> {
  const r = await providerDb.execute<{ status: string; settled_at: Date | null }>(
    sql`SELECT status, settled_at FROM outbound_ledger WHERE id = ${id} LIMIT 1`,
  );
  const row = r.rows[0];
  return row ? { status: row.status, settledAt: row.settled_at } : null;
}

const HOUR_AGO = new Date(Date.now() - 60 * 60_000);
const TWO_MIN_AGO = new Date(Date.now() - 2 * 60_000);

beforeAll(async () => {
  await setupTestDatabase();
  orgA = await createTestOrg(`parkedA-${Date.now()}`);
  orgB = await createTestOrg(`parkedB-${Date.now()}`);
  svc = new ParkedOutboundService();
});

afterAll(async () => {
  // Best-effort cleanup of the seeded ledger rows (FK restrict → before orgs).
  for (const org of [orgA, orgB]) {
    if (org) await providerDb.delete(outboundLedger).where(eq(outboundLedger.orgId, org.id));
  }
});

describe('ParkedOutboundService.list / count — buckets', () => {
  it('surfaces ambiguous (failure_code NOT NULL) + stale (failure_code NULL + old), excludes fresh + terminal', async () => {
    const p = await seedProposal(orgA.id);
    const r = `sigreq-${randomUUID()}`;
    // ambiguous: pending_send + failure_code
    const ambiguousId = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `${r}-amb`,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    // stale-crashed: pending_send + NULL failure_code + old
    const staleId = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `${r}-stale`,
      failureCode: null,
      createdAt: HOUR_AGO,
    });
    // fresh in-flight claim: pending_send + NULL + recent → NOT surfaced
    await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `${r}-fresh`,
      failureCode: null,
      createdAt: TWO_MIN_AGO,
    });
    // terminal sent / failed → NOT surfaced
    await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `${r}-sent`,
      status: 'sent',
      createdAt: HOUR_AGO,
    });
    await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `${r}-failed`,
      status: 'failed',
      failureCode: 'sms_rejected',
      createdAt: HOUR_AGO,
    });

    const page = await svc.list(manager(orgA), { limit: 100, staleMinutes: 15 });
    const ids = page.data.map((d) => d.id);
    expect(ids).toContain(ambiguousId);
    expect(ids).toContain(staleId);
    // exactly the two parked rows for this recipient family, nothing terminal/fresh
    const mine = page.data.filter((d) => d.recipientRef.startsWith(r));
    expect(mine.map((d) => d.id).sort()).toEqual([ambiguousId, staleId].sort());
    const amb = mine.find((d) => d.id === ambiguousId)!;
    expect(amb.reason).toBe('ambiguous');
    expect(amb.failureCode).toBe('send_threw');
    const stale = mine.find((d) => d.id === staleId)!;
    expect(stale.reason).toBe('stale');
    expect(stale.failureCode).toBeNull();
  });

  it('?reason filter narrows to one bucket', async () => {
    const p = await seedProposal(orgA.id);
    const r = `sigreq-${randomUUID()}`;
    const ambiguousId = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `${r}-amb`,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    const staleId = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `${r}-stale`,
      failureCode: null,
      createdAt: HOUR_AGO,
    });

    const ambOnly = await svc.list(manager(orgA), {
      limit: 100,
      staleMinutes: 15,
      reason: 'ambiguous',
    });
    const ambMine = ambOnly.data.filter((d) => d.recipientRef.startsWith(r));
    expect(ambMine.map((d) => d.id)).toEqual([ambiguousId]);

    const staleOnly = await svc.list(manager(orgA), {
      limit: 100,
      staleMinutes: 15,
      reason: 'stale',
    });
    const staleMine = staleOnly.data.filter((d) => d.recipientRef.startsWith(r));
    expect(staleMine.map((d) => d.id)).toEqual([staleId]);
  });

  it('a recent NULL-failure claim is NOT stale under a 15m window but IS under a 1m window', async () => {
    const p = await seedProposal(orgA.id);
    const r = `sigreq-${randomUUID()}-recent`;
    const id = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: r,
      failureCode: null,
      createdAt: TWO_MIN_AGO,
    });
    const wide = await svc.list(manager(orgA), { limit: 100, staleMinutes: 15 });
    expect(wide.data.map((d) => d.id)).not.toContain(id);
    const tight = await svc.list(manager(orgA), { limit: 100, staleMinutes: 1 });
    expect(tight.data.map((d) => d.id)).toContain(id);
  });

  it('count returns per-bucket totals', async () => {
    // Use a fresh org so the counts are deterministic.
    const org = await createTestOrg(`parkedC-${Date.now()}`);
    const p = await seedProposal(org.id);
    await seedLedger({
      orgId: org.id,
      proposalId: p,
      recipientRef: `c-amb-1`,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    await seedLedger({
      orgId: org.id,
      proposalId: p,
      recipientRef: `c-amb-2`,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    await seedLedger({
      orgId: org.id,
      proposalId: p,
      recipientRef: `c-stale-1`,
      failureCode: null,
      createdAt: HOUR_AGO,
    });
    const c = await svc.count(manager(org), { staleMinutes: 15 });
    expect(c.ambiguous).toBe(2);
    expect(c.stale).toBe(1);
    expect(c.total).toBe(3);
    await providerDb.delete(outboundLedger).where(eq(outboundLedger.orgId, org.id));
  });

  it('the wire shape carries NO PII fields (only ids/channel/failure_code/created_at)', async () => {
    const p = await seedProposal(orgA.id);
    const r = `sigreq-${randomUUID()}-pii`;
    await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: r,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    const page = await svc.list(manager(orgA), { limit: 100, staleMinutes: 15 });
    const row = page.data.find((d) => d.recipientRef === r)!;
    expect(Object.keys(row).sort()).toEqual(
      ['cadenceStep', 'channel', 'createdAt', 'failureCode', 'id', 'reason', 'recipientRef'].sort(),
    );
    // recipient_ref is the signature_request id handle — no phone/email/name leaks.
    expect(JSON.stringify(row)).not.toMatch(/phone|email|national_id|owner/i);
  });
});

describe('ParkedOutboundService — manager-only + RLS isolation', () => {
  it('a viewer is FORBIDDEN on list / count / resolve', async () => {
    await expect(svc.list(viewer(orgA), { limit: 25, staleMinutes: 15 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.count(viewer(orgA), { staleMinutes: 15 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.resolve(viewer(orgA), randomUUID(), { outcome: 'sent' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('org B cannot SEE org A parked rows (RLS)', async () => {
    const p = await seedProposal(orgA.id);
    const r = `sigreq-${randomUUID()}-rls`;
    const id = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: r,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    const bPage = await svc.list(manager(orgB), { limit: 100, staleMinutes: 15 });
    expect(bPage.data.map((d) => d.id)).not.toContain(id);
  });

  it('org B cannot RESOLVE org A parked row (RLS → 404)', async () => {
    const p = await seedProposal(orgA.id);
    const id = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `sigreq-${randomUUID()}-rls2`,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    await expect(svc.resolve(manager(orgB), id, { outcome: 'failed' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // org A's row is untouched (still pending_send).
    expect((await readLedger(id))!.status).toBe('pending_send');
  });
});

describe('ParkedOutboundService.resolve — exactly-once safety', () => {
  it('resolve→sent flips the row TERMINAL sent (delivery no-op, the exactly-once anchor)', async () => {
    const p = await seedProposal(orgA.id);
    const id = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `sigreq-${randomUUID()}-rsent`,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    const out = await svc.resolve(manager(orgA), id, { outcome: 'sent' });
    expect(out.status).toBe('sent');
    const row = await readLedger(id);
    // TERMINAL sent: the exactly-once anchor. A later governor claim on the same
    // key would pre-check this `sent` row → already_sent → NO re-send.
    expect(row!.status).toBe('sent');
    expect(row!.settledAt).not.toBeNull();
  });

  it('resolve→failed flips the row TERMINAL failed (the RE-CLAIMABLE state per H1)', async () => {
    const p = await seedProposal(orgA.id);
    const id = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `sigreq-${randomUUID()}-rfail`,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    const out = await svc.resolve(manager(orgA), id, { outcome: 'failed' });
    expect(out.status).toBe('failed');
    const row = await readLedger(id);
    // TERMINAL failed = the state the governor's C2 status-guarded UPDATE
    // re-claims (failed→pending_send) on the next approve → the reminder retries
    // the SAME step through the FULL governed path. resolve itself sends nothing.
    expect(row!.status).toBe('failed');
    expect(row!.settledAt).not.toBeNull();
  });

  it('resolving a non-pending_send row 409s (status guard — cannot race a settle / double-resolve)', async () => {
    const p = await seedProposal(orgA.id);
    const id = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `sigreq-${randomUUID()}-rterm`,
      status: 'sent',
      createdAt: HOUR_AGO,
    });
    await expect(svc.resolve(manager(orgA), id, { outcome: 'failed' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    // The already-terminal row is NOT downgraded.
    expect((await readLedger(id))!.status).toBe('sent');
  });

  it('a second resolve on an already-resolved row 409s (idempotent guard)', async () => {
    const p = await seedProposal(orgA.id);
    const id = await seedLedger({
      orgId: orgA.id,
      proposalId: p,
      recipientRef: `sigreq-${randomUUID()}-rdouble`,
      failureCode: 'send_threw',
      createdAt: HOUR_AGO,
    });
    await svc.resolve(manager(orgA), id, { outcome: 'sent' });
    await expect(svc.resolve(manager(orgA), id, { outcome: 'failed' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    // The first resolve's `sent` wins — a wrong second resolve→failed cannot
    // downgrade it (which would have re-enabled a double-send).
    expect((await readLedger(id))!.status).toBe('sent');
  });
});
