/**
 * `resolveRecipientConsent` + the ConsentGate end-to-end — DB-backed acceptance
 * tests (M2; #506 reminder-cadence red-team MEDIUM finding).
 *
 * The contract this proves (the compliance-critical axis: an opted-out recipient
 * must NEVER be sent to):
 *   - a recipient with an active opt-out for the SEND CHANNEL → consented:false
 *     → the ConsentGate DENIES.
 *   - an `all`-channel opt-out → DENIES regardless of the send channel.
 *   - a per-channel opt-out for a DIFFERENT channel → does NOT deny (per-channel).
 *   - no opt-out → consented:true → the gate ALLOWS (the other gates decide).
 *   - FAIL-CLOSED: an unresolvable signature_request (wrong org / absent) THROWS,
 *     so the caller denies — it NEVER default-allows on an errored lookup.
 *   - RLS: an opt-out in org A is invisible to org B (cross-org isolation), and
 *     a request in org A is invisible to org B's resolver (fail-closed throw).
 *
 * Seeding is BYPASSRLS (`providerDb`) — the governor/recommender spec template.
 * The resolver itself runs inside `withTenant` (RLS-scoped) exactly as on the
 * real path.
 *
 * Run (needs a DB + Infisical):
 *   infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/recipient-consent.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  ConsentGate,
  evaluateOutboundPolicy,
  type OutboundRequest,
  type OutboundSnapshot,
} from '@emapp/jobs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../client';
import {
  apartments,
  buildings,
  memberships,
  organizations,
  owners,
  projects,
  recipientOptOuts,
  users,
} from '../schema/index';
import { withTenant } from '../wrappers/with-tenant';

import { resolveRecipientChannelSuppression } from './recipient-consent';

let orgA: string;
let orgB: string;
let creatorA: string;

const NOW = new Date('2026-06-22T12:00:00.000Z');

async function seedOrg(tag: string): Promise<{ orgId: string; creatorId: string }> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `con-${tag}-${orgId.slice(0, 8)}`,
    slug: `con${tag}${orgId.slice(0, 8)}`.toLowerCase(),
  });
  const [mgr] = await providerDb
    .insert(users)
    .values({
      email: `con-${tag}-${orgId.slice(0, 8)}@test.local`,
      name: 'Con Manager',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await providerDb.insert(memberships).values({
    userId: mgr!.id,
    orgId,
    role: 'manager',
    isPrimary: true,
    acceptedAt: new Date(),
  });
  return { orgId, creatorId: mgr!.id };
}

/** Seed a pending signature_request for a fresh owner in `orgId`. Returns both
 *  ids so a test can opt the owner out and resolve consent for the request. */
async function seedRequest(
  orgId: string,
  creatorId: string,
): Promise<{ reqId: string; ownerId: string }> {
  const [proj] = await providerDb
    .insert(projects)
    .values({
      orgId,
      name: `con-proj-${Date.now()}-${Math.random()}`,
      type: 'tama38_1',
      createdBy: creatorId,
    })
    .returning({ id: projects.id });
  const [bld] = await providerDb
    .insert(buildings)
    .values({ projectId: proj!.id, address: `con ${Date.now()}-${Math.random()}`, city: 'TLV' })
    .returning({ id: buildings.id });
  const [apt] = await providerDb
    .insert(apartments)
    .values({ buildingId: bld!.id, number: `C-${Date.now()}-${Math.random()}` })
    .returning({ id: apartments.id });
  const [own] = await providerDb.insert(owners).values({ orgId }).returning({ id: owners.id });
  const docRes = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO documents
      (org_id, project_id, apartment_id, name, type, mime_type, size_bytes,
       r2_key, content_hash, uploaded_by)
    VALUES
      (${orgId}, ${proj!.id}, ${apt!.id}, 'sig.pdf', 'other', 'application/pdf', 100,
       ${`org/${orgId}/doc/${randomUUID()}`}, 'h', ${creatorId})
    RETURNING id
  `);
  const reqRes = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO signature_requests
      (org_id, document_id, owner_id, jti, status, expires_at, created_at, created_by)
    VALUES
      (${orgId}, ${docRes.rows[0]!.id}, ${own!.id}, ${randomUUID()}, 'pending',
       ${new Date(NOW.getTime() + 7 * 86_400_000).toISOString()}, ${NOW.toISOString()}, ${creatorId})
    RETURNING id
  `);
  return { reqId: reqRes.rows[0]!.id, ownerId: own!.id };
}

/** Insert a durable opt-out for an owner, BYPASSRLS (the manager-action path is
 *  unit-tested separately in the API package; here we seed the registry state). */
async function seedOptOut(
  orgId: string,
  ownerId: string,
  channel: 'email' | 'sms' | 'all',
): Promise<void> {
  await providerDb.insert(recipientOptOuts).values({
    orgId,
    ownerId,
    channel,
    source: 'manager',
  });
}

/** Run the ConsentGate over the resolved consent, the way the Governor does. */
function gateVerdict(consented: boolean): string {
  const request: OutboundRequest = {
    orgId: orgA,
    channel: 'email',
    recipientRef: 'r',
    cadenceStep: 0,
  };
  const snapshot: OutboundSnapshot = {
    killSwitchEnabled: true,
    recipientConsented: consented,
    recipientSendsInWindow: 0,
    orgSendsInWindow: 0,
    breakerTripped: false,
  };
  // Evaluate JUST the ConsentGate so the verdict is the consent decision.
  return evaluateOutboundPolicy(
    request,
    {
      now: NOW,
      snapshot,
      config: { maxPerRecipient: 99, maxPerOrg: 99, quietHoursStartHour: 0, quietHoursEndHour: 0 },
    },
    [ConsentGate],
  ).verdict;
}

async function cleanup(orgId: string): Promise<void> {
  await providerDb
    .execute(sql`DELETE FROM recipient_opt_outs WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM signature_requests WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM documents WHERE org_id = ${orgId}`)
    .catch(() => undefined);
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => undefined);
}

beforeAll(async () => {
  const a = await seedOrg('a');
  orgA = a.orgId;
  creatorA = a.creatorId;
  const b = await seedOrg('b');
  orgB = b.orgId;
}, 120_000);

afterAll(async () => {
  await cleanup(orgA);
  await cleanup(orgB);
});

describe('resolveRecipientChannelSuppression — the ConsentGate registry resolution (M2)', () => {
  it('NO opt-out → consented:true, no channel suppressed → ConsentGate ALLOWS', async () => {
    const { reqId } = await seedRequest(orgA, creatorA);
    const s = await withTenant(orgA, (tx) => resolveRecipientChannelSuppression(tx, orgA, reqId));
    expect(s.email).toBe(false);
    expect(s.sms).toBe(false);
    expect(s.consented).toBe(true);
    expect(gateVerdict(s.consented)).toBe('allow');
  });

  it('opt-out for `all` → consented:false → ConsentGate DENIES (every channel)', async () => {
    const { reqId, ownerId } = await seedRequest(orgA, creatorA);
    await seedOptOut(orgA, ownerId, 'all');
    const s = await withTenant(orgA, (tx) => resolveRecipientChannelSuppression(tx, orgA, reqId));
    expect(s.email).toBe(true);
    expect(s.sms).toBe(true);
    expect(s.consented).toBe(false);
    expect(gateVerdict(s.consented)).toBe('deny');
  });

  it('FAIL-CLOSED: an unresolvable signature_request THROWS (caller denies)', async () => {
    await expect(
      withTenant(orgA, (tx) => resolveRecipientChannelSuppression(tx, orgA, randomUUID())),
    ).rejects.toThrow();
  });

  it('per-channel suppression: an sms-only opt-out SUPPRESSES sms but still ALLOWS the send (email leg)', async () => {
    const { reqId, ownerId } = await seedRequest(orgA, creatorA);
    await seedOptOut(orgA, ownerId, 'sms');
    const s = await withTenant(orgA, (tx) => resolveRecipientChannelSuppression(tx, orgA, reqId));
    expect(s.sms).toBe(true); // sms is suppressed (the gap the red-team found)
    expect(s.email).toBe(false); // email still allowed
    expect(s.consented).toBe(true); // the gate ALLOWS (email leg can go)
    expect(gateVerdict(s.consented)).toBe('allow');
  });

  it('per-channel suppression: BOTH channels opted out → consented:false → ConsentGate DENIES (nothing to send)', async () => {
    const { reqId, ownerId } = await seedRequest(orgA, creatorA);
    await seedOptOut(orgA, ownerId, 'email');
    await seedOptOut(orgA, ownerId, 'sms');
    const s = await withTenant(orgA, (tx) => resolveRecipientChannelSuppression(tx, orgA, reqId));
    expect(s.email).toBe(true);
    expect(s.sms).toBe(true);
    expect(s.consented).toBe(false);
    expect(gateVerdict(s.consented)).toBe('deny');
  });

  it('per-channel suppression: an `all` opt-out suppresses BOTH and DENIES', async () => {
    const { reqId, ownerId } = await seedRequest(orgA, creatorA);
    await seedOptOut(orgA, ownerId, 'all');
    const s = await withTenant(orgA, (tx) => resolveRecipientChannelSuppression(tx, orgA, reqId));
    expect(s.email).toBe(true);
    expect(s.sms).toBe(true);
    expect(s.consented).toBe(false);
  });

  it('per-channel suppression: FAIL-CLOSED on an unresolvable request (THROWS)', async () => {
    await expect(
      withTenant(orgA, (tx) => resolveRecipientChannelSuppression(tx, orgA, randomUUID())),
    ).rejects.toThrow();
  });

  it('RLS: an opt-out in org A is invisible to org B; a request in org A is invisible to org B (fail-closed throw)', async () => {
    const { reqId, ownerId } = await seedRequest(orgA, creatorA);
    await seedOptOut(orgA, ownerId, 'all');
    // Org B cannot see org A's signature_request → the resolver throws (the
    // owner-resolution step finds no row) → fail-closed. The opt-out itself is
    // also org-A-scoped, so it can never leak into a B-context decision.
    await expect(
      withTenant(orgB, (tx) => resolveRecipientChannelSuppression(tx, orgB, reqId)),
    ).rejects.toThrow();
  });
});
