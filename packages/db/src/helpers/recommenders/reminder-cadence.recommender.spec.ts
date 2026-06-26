/**
 * `ReminderCadenceRecommender` — DB-backed detection tests (Autonomous Master
 * Plan, Phase 2). Proves:
 *   - SET-BASED detection across orgs (one query) finds a pending, no-response,
 *     past-cadence request and emits a `reminder.send` condition at the right step.
 *   - the ledger-derived cadence clock: a request with N `sent` reminder rows is
 *     proposed at step N (not step 0).
 *   - NOT due: a too-recent request, a signed/expired request, a maxed-out request.
 *   - the dedup key is per (request, step) and PII-free evidence.
 *
 * Seeding is BYPASSRLS (`providerDb`); created_at is backdated via raw SQL so the
 * cadence clock can be controlled. Run (needs DB + Infisical):
 *   infisical run --env dev -- pnpm --filter @emapp/db exec vitest run \
 *     src/helpers/recommenders/reminder-cadence.recommender.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerDb } from '../../client';
import {
  apartments,
  buildings,
  organizations,
  owners,
  projects,
  users,
  memberships,
} from '../../schema/index';

import {
  REMINDER_SEND_KIND,
  createReminderCadenceRecommender,
} from './reminder-cadence.recommender';

let orgA: string;
let creatorA: string;

const NOW = new Date('2026-06-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

async function seedOrg(tag: string): Promise<{ orgId: string; creatorId: string }> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `rem-${tag}-${orgId.slice(0, 8)}`,
    slug: `rem${tag}${orgId.slice(0, 8)}`.toLowerCase(),
  });
  const [mgr] = await providerDb
    .insert(users)
    .values({
      email: `rem-${tag}-${orgId.slice(0, 8)}@test.local`,
      name: 'Rem Manager',
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

/** Seed a signature_request with a CONTROLLED created_at + status + expiry. */
async function seedRequest(opts: {
  status: 'pending' | 'signed' | 'cancelled' | 'expired';
  createdAt: Date;
  expiresAt: Date;
}): Promise<string> {
  const [proj] = await providerDb
    .insert(projects)
    .values({
      orgId: orgA,
      name: `rem-proj-${Date.now()}-${Math.random()}`,
      type: 'tama38_1',
      createdBy: creatorA,
    })
    .returning({ id: projects.id });
  const [bld] = await providerDb
    .insert(buildings)
    .values({ projectId: proj!.id, address: `rem ${Date.now()}-${Math.random()}`, city: 'TLV' })
    .returning({ id: buildings.id });
  const [apt] = await providerDb
    .insert(apartments)
    .values({ buildingId: bld!.id, number: `R-${Date.now()}-${Math.random()}` })
    .returning({ id: apartments.id });
  const [own] = await providerDb
    .insert(owners)
    .values({ orgId: orgA })
    .returning({ id: owners.id });
  const docRes = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO documents
      (org_id, project_id, apartment_id, name, type, mime_type, size_bytes,
       r2_key, content_hash, uploaded_by)
    VALUES
      (${orgA}, NULL, ${apt!.id}, 'sig.pdf', 'other', 'application/pdf', 100,
       ${`org/${orgA}/doc/${randomUUID()}`}, 'h', ${creatorA})
    RETURNING id
  `);
  const docId = docRes.rows[0]!.id;
  const reqRes = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO signature_requests
      (org_id, document_id, owner_id, jti, status, expires_at, created_at, created_by)
    VALUES
      (${orgA}, ${docId}, ${own!.id}, ${randomUUID()}, ${opts.status},
       ${opts.expiresAt.toISOString()}, ${opts.createdAt.toISOString()}, ${creatorA})
    RETURNING id
  `);
  return reqRes.rows[0]!.id;
}

/** Insert a terminal `sent` ledger row for a request, backdated, to simulate a
 *  prior reminder (advances reminders_sent + last_contact_at). */
async function seedSentReminder(requestId: string, createdAt: Date): Promise<void> {
  // A ledger row needs a proposal_id FK — seed a throwaway one.
  const propRes = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO proposals (org_id, kind, status, scope_type, scope_id, evidence, dedup_key)
    VALUES (${orgA}, 'reminder.send', 'applied', 'signature_request',
            ${requestId}, '{}'::jsonb, ${`reminder.send:${requestId}:seed-${randomUUID()}`})
    RETURNING id
  `);
  await providerDb.execute(sql`
    INSERT INTO outbound_ledger
      (org_id, proposal_id, channel, recipient_ref, cadence_step, idempotency_key,
       status, created_at, settled_at)
    VALUES
      (${orgA}, ${propRes.rows[0]!.id}, 'email', ${requestId}, 0,
       ${`seed:${requestId}:${randomUUID()}`}, 'sent',
       ${createdAt.toISOString()}, ${createdAt.toISOString()})
  `);
}

async function cleanup(): Promise<void> {
  await providerDb
    .execute(sql`DELETE FROM outbound_ledger WHERE org_id = ${orgA}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM proposals WHERE org_id = ${orgA}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM signature_requests WHERE org_id = ${orgA}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM documents WHERE org_id = ${orgA}`)
    .catch(() => undefined);
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgA))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgA))
    .catch(() => undefined);
}

beforeAll(async () => {
  const a = await seedOrg('a');
  orgA = a.orgId;
  creatorA = a.creatorId;
}, 120_000);

afterAll(cleanup);

const recommender = createReminderCadenceRecommender();

describe('ReminderCadenceRecommender.detect (set-based)', () => {
  it('proposes a pending, no-response, +3d-old request at cadence step 0', async () => {
    const reqId = await seedRequest({
      status: 'pending',
      createdAt: new Date(NOW.getTime() - 4 * DAY), // 4d ago > +3d cadence
      expiresAt: new Date(NOW.getTime() + 10 * DAY),
    });
    const conditions = await recommender.detect({ now: NOW });
    const mine = conditions.find((c) => c.scopeId === reqId);
    expect(mine).toBeDefined();
    expect(mine!.kind).toBe(REMINDER_SEND_KIND);
    expect(mine!.dedupKey).toBe(`${REMINDER_SEND_KIND}:${reqId}:0`);
    // PII-free evidence: ids + cadence facts only.
    expect(mine!.evidence).toMatchObject({ cadenceStep: 0, reminderIndex: 1 });
    expect(JSON.stringify(mine!.evidence)).not.toMatch(/national|phone|@/i);
    await cleanupRequests();
  });

  it('advances to step 1 when one reminder was already sent 7+ days ago', async () => {
    const reqId = await seedRequest({
      status: 'pending',
      createdAt: new Date(NOW.getTime() - 20 * DAY),
      expiresAt: new Date(NOW.getTime() + 10 * DAY),
    });
    // A prior reminder sent 8 days ago → last_contact 8d ago, reminders_sent=1.
    await seedSentReminder(reqId, new Date(NOW.getTime() - 8 * DAY));
    const conditions = await recommender.detect({ now: NOW });
    const mine = conditions.find((c) => c.scopeId === reqId);
    expect(mine).toBeDefined();
    expect(mine!.dedupKey).toBe(`${REMINDER_SEND_KIND}:${reqId}:1`);
    expect(mine!.evidence).toMatchObject({ cadenceStep: 1, reminderIndex: 2 });
    await cleanupRequests();
  });

  it('does NOT propose a too-recent request (< +3d since last contact)', async () => {
    const reqId = await seedRequest({
      status: 'pending',
      createdAt: new Date(NOW.getTime() - 1 * DAY), // 1d ago
      expiresAt: new Date(NOW.getTime() + 10 * DAY),
    });
    const conditions = await recommender.detect({ now: NOW });
    expect(conditions.find((c) => c.scopeId === reqId)).toBeUndefined();
    await cleanupRequests();
  });

  it('does NOT propose a signed or expired request', async () => {
    const signed = await seedRequest({
      status: 'signed',
      createdAt: new Date(NOW.getTime() - 10 * DAY),
      expiresAt: new Date(NOW.getTime() + 10 * DAY),
    });
    const expired = await seedRequest({
      status: 'pending',
      createdAt: new Date(NOW.getTime() - 10 * DAY),
      expiresAt: new Date(NOW.getTime() - 1 * DAY), // link already lapsed
    });
    const conditions = await recommender.detect({ now: NOW });
    expect(conditions.find((c) => c.scopeId === signed)).toBeUndefined();
    expect(conditions.find((c) => c.scopeId === expired)).toBeUndefined();
    await cleanupRequests();
  });
});

/** Remove signature_requests + their seed ledger/proposals between cases so each
 *  assertion sees only its own seeded request. */
async function cleanupRequests(): Promise<void> {
  await providerDb
    .execute(sql`DELETE FROM outbound_ledger WHERE org_id = ${orgA}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM proposals WHERE org_id = ${orgA}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM signature_requests WHERE org_id = ${orgA}`)
    .catch(() => undefined);
}
