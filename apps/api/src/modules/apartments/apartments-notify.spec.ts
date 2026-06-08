/**
 * P5.S3 — apartment_status_changed notification fan-out (real-DB, adversarial).
 *
 * ApartmentsService.update(user, id, input) emits, best-effort AFTER commit, an
 * `apartment_status_changed` notification ONLY when the status ACTUALLY changes
 * (input.status !== before.status). Recipients are resolved through the ONE
 * central helper `resolveNotificationRecipients` (D-O7 default):
 *
 *   recipients = (ALL active org MANAGERS)               ← managers ALWAYS notified
 *              ∪ (active project-assigned AGENTS)         ← apartment→building→project
 *              − the ACTOR (user.sub)                     ← self-exclusion (managers too)
 *
 * metadata carries { apartmentId, fromStatus, toStatus }. apartment number +
 * status are same-org-visible labels (NOT PII), so they may sit in the body.
 *
 * NO-OP GUARD (load-bearing): an update that does NOT change the status (same
 * status, or only touches other fields) emits ZERO notifications. The emit is
 * gated INSIDE the `status !== before.status` branch — test AS-5 fails if the
 * emit were hoisted outside that guard.
 *
 * Ground truth: the `notifications` table is read via providerPool (BYPASSRLS).
 */
import { randomUUID } from 'node:crypto';

import { buildings, db, memberships, projectAssignments, users, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { ApartmentsService } from './apartments.service';

let svc: ApartmentsService;
let org: TestOrg;
let managerA: string; // createTestOrg-seeded manager
let managerB: string; // SECOND manager — so managers-always − actor isn't vacuous
let projectTeam: string; // projects[0] — agentA + agentB assigned
let buildingTeam: string; // a building under projectTeam (hosts the apartments)

let agentA: string; // assigned to projectTeam
let agentB: string; // assigned to projectTeam
let nonAssignee: string; // assigned to nothing — never a project recipient

const SID = '00000000-0000-4000-8000-0000000000b0';

function payload(sub: string, role: 'manager' | 'agent'): AccessTokenPayload {
  return { sub, orgId: org.id, role, sid: SID, type: 'access' } as unknown as AccessTokenPayload;
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `agent-${randomUUID()}@test.local`, name: 'Agent', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db.insert(memberships).values({
    userId: u!.id,
    orgId,
    role: 'agent',
    acceptedAt: new Date(),
  });
  return u!.id;
}

async function seedManager(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `manager-${randomUUID()}@test.local`,
      name: 'Manager',
      passwordHash: '$2b$12$x',
    })
    .returning({ id: users.id });
  await db.insert(memberships).values({
    userId: u!.id,
    orgId,
    role: 'manager',
    acceptedAt: new Date(),
  });
  return u!.id;
}

async function assign(projectId: string, userId: string): Promise<void> {
  await db.insert(projectAssignments).values({ projectId, userId, assignedBy: managerA });
}

/** Insert an apartment directly (BYPASS the service) at a known starting status. */
async function seedApartment(buildingId: string, status = 'pending'): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number, status)
       VALUES ($1, $2, $3) RETURNING id`,
      [buildingId, `${Math.floor(Math.random() * 10000000)}`, status],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** apartment_status_changed rows for a recipient, matching a given apartmentId. */
async function statusChangedFor(
  userId: string,
  apartmentId: string,
): Promise<
  Array<{ type: string; title: string; body: string | null; metadata: Record<string, unknown> }>
> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      type: string;
      title: string;
      body: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT type, title, body, metadata FROM notifications
       WHERE user_id = $1 AND org_id = $2 AND type = 'apartment_status_changed'
       ORDER BY created_at DESC`,
      [userId, org.id],
    );
    return r.rows.filter((n) => n.metadata?.apartmentId === apartmentId);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ApartmentsService(new NotificationsProducerService());
  const tag = `apt-notify-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerA = org.users[0]!.id;
  projectTeam = org.projects[0]!.id;

  managerB = await seedManager(org.id);
  agentA = await seedAgent(org.id);
  agentB = await seedAgent(org.id);
  nonAssignee = await seedAgent(org.id);

  await assign(projectTeam, agentA);
  await assign(projectTeam, agentB);

  // One building under projectTeam to host the apartments.
  buildingTeam = await withTenant(
    org.id,
    async (tx) => {
      const [b] = await tx
        .insert(buildings)
        .values({ projectId: projectTeam, address: 'Dizengoff 1', city: 'TLV' })
        .returning({ id: buildings.id });
      return b!.id;
    },
    { userId: managerA },
  );
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('P5.S3 — apartment_status_changed notification fan-out', () => {
  it('AS-4) a manager changes status (pending→signed, REAL change) → project agents + the OTHER managers notified; the actor NOT; metadata carries from/to', async () => {
    const aptId = await seedApartment(buildingTeam, 'pending');

    // managerA performs the change. Recipients = managers(A,B) ∪ projectTeam
    //   agents(A,B) − actor(managerA) = {managerB, agentA, agentB}.
    const res = await svc.update(payload(managerA, 'manager'), aptId, { status: 'signed' });
    expect(res.id).toBe(aptId);
    expect(res.status).toBe('signed');

    // project agents notified.
    const a = await statusChangedFor(agentA, aptId);
    const b = await statusChangedFor(agentB, aptId);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    for (const n of [a[0]!, b[0]!]) {
      expect(n.type).toBe('apartment_status_changed');
      expect(n.title).toBe('סטטוס דירה עודכן');
      // metadata carries the REAL transition.
      expect(n.metadata.apartmentId).toBe(aptId);
      expect(n.metadata.fromStatus).toBe('pending');
      expect(n.metadata.toStatus).toBe('signed');
    }

    // the OTHER manager (managers-always, not the actor) → notified.
    expect(await statusChangedFor(managerB, aptId)).toHaveLength(1);
    // the actor → NOT notified.
    expect(await statusChangedFor(managerA, aptId)).toHaveLength(0);
    // non-assignee → never a recipient.
    expect(await statusChangedFor(nonAssignee, aptId)).toHaveLength(0);
  }, 30_000);

  it('AS-5) NO-OP GUARD (load-bearing): same-status update AND an other-field-only update emit ZERO notifications', async () => {
    // Start at 'signed'. Two no-op-for-status updates:
    //   (a) set status to the SAME value it already has.
    //   (b) touch a NON-status field (notes), status untouched.
    // Both must produce ZERO apartment_status_changed rows. This FAILS if the
    // emit were outside the `status !== before.status` guard.
    const aptId = await seedApartment(buildingTeam, 'signed');

    // (a) same status.
    const res1 = await svc.update(payload(managerA, 'manager'), aptId, { status: 'signed' });
    expect(res1.status).toBe('signed');

    // (b) other field only (no status key at all).
    const res2 = await svc.update(payload(managerA, 'manager'), aptId, { notes: 'just a note' });
    expect(res2.status).toBe('signed');
    expect(res2.notes).toBe('just a note');

    // NOBODY anywhere got an apartment_status_changed row for this apartment.
    for (const uid of [managerA, managerB, agentA, agentB, nonAssignee]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await statusChangedFor(uid, aptId)).toHaveLength(0);
    }
  }, 30_000);

  it('AS-5b) NON-VACUOUS control: the SAME apartment then gets a REAL change → exactly one row appears (proves AS-5 zero was the guard, not a dead path)', async () => {
    // Reuse a fresh apartment: prove that, against the IDENTICAL recipient seed,
    // a real transition DOES emit — so AS-5's "zero" is the guard at work, not an
    // accidentally-empty recipient set.
    const aptId = await seedApartment(buildingTeam, 'pending');

    // First a no-op (same status) — zero.
    await svc.update(payload(managerB, 'manager'), aptId, { status: 'pending' });
    for (const uid of [managerA, agentA, agentB]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await statusChangedFor(uid, aptId)).toHaveLength(0);
    }

    // Then a REAL change by managerB → recipients {managerA, agentA, agentB}.
    const res = await svc.update(payload(managerB, 'manager'), aptId, { status: 'contacted' });
    expect(res.status).toBe('contacted');
    expect(await statusChangedFor(managerA, aptId)).toHaveLength(1);
    expect(await statusChangedFor(agentA, aptId)).toHaveLength(1);
    expect(await statusChangedFor(agentB, aptId)).toHaveLength(1);
    // managerB (actor) excluded.
    expect(await statusChangedFor(managerB, aptId)).toHaveLength(0);
  }, 30_000);

  it('AS-6) actor-exclusion + dedup: an actor who is BOTH a manager AND a project assignee is excluded once; double-qualifying recipients appear once', async () => {
    // managerB is assigned to projectTeam → qualifies via managers-always AND
    // via project-assignee. When managerB changes a status, they must be excluded
    // (actor), and OTHER recipients who double-qualify appear exactly once.
    await assign(projectTeam, managerB);
    const aptId = await seedApartment(buildingTeam, 'pending');

    const res = await svc.update(payload(managerB, 'manager'), aptId, { status: 'meeting' });
    expect(res.status).toBe('meeting');

    // managerB: actor + manager + assignee → excluded entirely → zero rows.
    expect(await statusChangedFor(managerB, aptId)).toHaveLength(0);

    // managerA (manager-always only) → exactly one (no dup).
    expect(await statusChangedFor(managerA, aptId)).toHaveLength(1);
    // agentA + agentB (assignee only) → exactly one each.
    expect(await statusChangedFor(agentA, aptId)).toHaveLength(1);
    expect(await statusChangedFor(agentB, aptId)).toHaveLength(1);
    expect(await statusChangedFor(nonAssignee, aptId)).toHaveLength(0);
  }, 30_000);
});
