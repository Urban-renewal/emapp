/**
 * Slice 2.1 — bulk APARTMENT GENERATION (real-DB).
 *
 * `ApartmentsService.generate(user, buildingId, { floors, apartmentsPerFloor,
 * scheme })` LOOPS the canonical apartment-create path inside ONE `withTenant`
 * transaction. The contract under test against the REAL local DB (so the loop
 * runs under RLS + the partial-unique index, exactly as in prod):
 *
 *  - generate N (floors×perFloor) → EXACTLY N apartments created, all under the
 *    target building, with the correct numbering for the scheme.
 *  - canonical defaults flow through (unitType='apt', status='pending') — proof
 *    it reuses the create seam, not a second insert path.
 *  - ATOMIC: a mid-loop failure rolls the WHOLE batch back (zero partial rows).
 *  - IDEMPOTENT / collision-safe: re-generating the same shape over a building
 *    that already has those numbers creates 0 and reports them skipped (the
 *    second run never duplicates or throws on the unique index).
 *  - ROLE/scope gating: a viewer (no edit_project_data) is rejected; a foreign
 *    / unknown building is 404 (no oracle), never a cross-tenant write.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/apartments/apartments-generate.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { apartments, buildings, withTenant } from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { ApartmentsService } from './apartments.service';

let svc: ApartmentsService;
let org: TestOrg;
let orgB: TestOrg;
let mgrAId: string;
let mgrBId: string;
let projectTeam: string;
let buildingB: string; // an org-B building — cross-tenant control

function managerA(): AccessTokenPayload {
  return {
    sub: mgrAId,
    orgId: org.id,
    role: 'manager',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}

// A viewer's service-layer rejection does NOT need a real user row: the gate is
// `requireAgentCapability`, which throws for any role that is neither manager
// nor agent (it only reads `memberships` for agents). A synthetic viewer payload
// is sufficient and isolates this test from the users schema.
function viewerA(): AccessTokenPayload {
  return {
    sub: randomUUID(),
    orgId: org.id,
    role: 'viewer',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedBuilding(orgId: string, projectId: string, userId: string): Promise<string> {
  return withTenant(
    orgId,
    async (tx) => {
      const [b] = await tx
        .insert(buildings)
        .values({ projectId, address: `St ${randomUUID().slice(0, 6)}`, city: 'TLV' })
        .returning({ id: buildings.id });
      return b!.id;
    },
    { userId },
  );
}

/** Read back the active apartments of a building (number-ordered for assertions). */
async function activeApartments(orgId: string, userId: string, buildingId: string) {
  return withTenant(
    orgId,
    async (tx) =>
      tx
        .select({
          id: apartments.id,
          number: apartments.number,
          floor: apartments.floor,
          status: apartments.status,
          unitType: apartments.unitType,
        })
        .from(apartments)
        .where(and(eq(apartments.buildingId, buildingId), isNull(apartments.archivedAt))),
    { userId },
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ApartmentsService(new NotificationsProducerService());
  const tag = `apt-gen-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  orgB = await createTestOrg(`${tag}-b`, `${tag}-b`);
  mgrAId = org.users[0]!.id;
  mgrBId = orgB.users[0]!.id;
  projectTeam = org.projects[0]!.id;

  buildingB = await seedBuilding(orgB.id, orgB.projects[0]!.id, mgrBId);
}, 120_000);

afterAll(async () => {
  // Tagged rows are harmless to leave; other suites filter by their own ids.
});

describe('apartments generate — bulk creation', () => {
  it('sequential: floors×perFloor → exactly N apartments, numbered 1..N', async () => {
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    const res = await svc.generate(managerA(), b, {
      floors: 4,
      apartmentsPerFloor: 3,
      scheme: 'sequential',
    });
    expect(res).toEqual({ created: 12, skipped: 0 });

    const rows = await activeApartments(org.id, mgrAId, b);
    expect(rows).toHaveLength(12);
    const numbers = rows.map((r) => Number(r.number)).sort((a, z) => a - z);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // canonical defaults flowed through the reused create seam.
    expect(rows.every((r) => r.unitType === 'apt')).toBe(true);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    // floors are tracked: 3 apartments on each of 4 floors (1..4).
    const byFloor = new Map<number, number>();
    for (const r of rows) byFloor.set(r.floor!, (byFloor.get(r.floor!) ?? 0) + 1);
    expect([...byFloor.entries()].sort()).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
      [4, 3],
    ]);
  });

  it('floorBased: floor*100+unit numbering (101,102 / 201,202 …)', async () => {
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    const res = await svc.generate(managerA(), b, {
      floors: 2,
      apartmentsPerFloor: 2,
      scheme: 'floorBased',
    });
    expect(res.created).toBe(4);
    const rows = await activeApartments(org.id, mgrAId, b);
    const numbers = rows.map((r) => Number(r.number)).sort((a, z) => a - z);
    expect(numbers).toEqual([101, 102, 201, 202]);
  });

  it('is collision-safe + idempotent: a second identical generate creates 0, skips all', async () => {
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    const first = await svc.generate(managerA(), b, {
      floors: 3,
      apartmentsPerFloor: 5,
      scheme: 'sequential',
    });
    expect(first).toEqual({ created: 15, skipped: 0 });

    // Re-run the SAME shape — every number already exists (active) → all skipped,
    // never a duplicate, never a unique-index throw.
    const second = await svc.generate(managerA(), b, {
      floors: 3,
      apartmentsPerFloor: 5,
      scheme: 'sequential',
    });
    expect(second).toEqual({ created: 0, skipped: 15 });

    const rows = await activeApartments(org.id, mgrAId, b);
    expect(rows).toHaveLength(15); // still 15, no dupes
  });

  it('fills only the gaps when re-generating a LARGER shape over an existing run', async () => {
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    await svc.generate(managerA(), b, { floors: 1, apartmentsPerFloor: 3, scheme: 'sequential' }); // 1,2,3
    // 2×3 sequential = 1..6; 1,2,3 already exist → only 4,5,6 created.
    const res = await svc.generate(managerA(), b, {
      floors: 2,
      apartmentsPerFloor: 3,
      scheme: 'sequential',
    });
    expect(res).toEqual({ created: 3, skipped: 3 });
    const rows = await activeApartments(org.id, mgrAId, b);
    expect(rows.map((r) => Number(r.number)).sort((a, z) => a - z)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('skips a pre-existing active number, creating only the rest', async () => {
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    const c = await providerPool.connect();
    try {
      await c.query(
        `INSERT INTO apartments (building_id, number, status) VALUES ($1,'5','pending')`,
        [b],
      );
    } finally {
      c.release();
    }
    // 1..10 sequential; "5" already active → created 9 (1..4,6..10), skipped 1.
    const res = await svc.generate(managerA(), b, {
      floors: 1,
      apartmentsPerFloor: 10,
      scheme: 'sequential',
    });
    expect(res).toEqual({ created: 9, skipped: 1 });
    const rows = await activeApartments(org.id, mgrAId, b);
    expect(rows.map((r) => Number(r.number)).sort((a, z) => a - z)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('ATOMIC: a failure mid-loop rolls the WHOLE batch back (no partial rows)', async () => {
    // Force the 5th insertion in a 1..10 generate to throw. If the loop ran in
    // ONE withTenant tx, the rollback leaves ZERO apartments — not the 4 that
    // were already inserted before the failure. (Spy the private insertion seam
    // both create + generate share; restore after so other tests are unaffected.)
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    const proto = ApartmentsService.prototype as unknown as {
      insertApartment: (...args: unknown[]) => Promise<unknown>;
    };
    const original = proto.insertApartment;
    let calls = 0;
    const spy = vi.spyOn(proto, 'insertApartment').mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      calls += 1;
      if (calls === 5) throw new Error('injected mid-loop failure');
      return original.apply(this, args);
    });

    let caught: unknown;
    try {
      await svc.generate(managerA(), b, {
        floors: 1,
        apartmentsPerFloor: 10,
        scheme: 'sequential',
      });
    } catch (e) {
      caught = e;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(Error);
    const rows = await activeApartments(org.id, mgrAId, b);
    expect(rows).toHaveLength(0); // all-or-nothing: the 4 prior inserts rolled back
  });

  it('rejects a viewer (no edit_project_data) — fail-closed, no rows written', async () => {
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    let caught: unknown;
    try {
      await svc.generate(viewerA(), b, { floors: 2, apartmentsPerFloor: 2, scheme: 'sequential' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const rows = await activeApartments(org.id, mgrAId, b);
    expect(rows).toHaveLength(0); // gate ran BEFORE any insert
  });

  it('404s on a cross-tenant building — never a cross-tenant write', async () => {
    let caught: unknown;
    try {
      await svc.generate(managerA(), buildingB, {
        floors: 2,
        apartmentsPerFloor: 2,
        scheme: 'sequential',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
    expect((caught as NotFoundException).getStatus()).toBe(404);
    // org-B building still empty (the org-A manager could not write into it).
    const rows = await activeApartments(orgB.id, mgrBId, buildingB);
    expect(rows).toHaveLength(0);
  });

  it('404s on an unknown building uuid', async () => {
    let caught: unknown;
    try {
      await svc.generate(managerA(), randomUUID(), {
        floors: 1,
        apartmentsPerFloor: 1,
        scheme: 'sequential',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
  });
});
