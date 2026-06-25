/**
 * Apartments LIST — additive server-side `status` filter (real-DB).
 *
 * `ApartmentsService.list(user, buildingId, { status })` ANDs
 * `eq(apartments.status, status)` into the existing
 * `building_id = $b AND archived_at IS NULL [AND keyset]` WHERE — a pure
 * PREDICATE, not a reorder, so the keyset cursor/order stay intact. Mirrors the
 * NS1 `projectSearchFilters` idiom (projects-search.spec.ts is the template).
 *
 * THE CONTRACT under test (against the REAL local DB, so the predicate runs in
 * SQL under RLS inside withTenant — mocking would defeat the point):
 *  - filter restricts to the EXACT status; non-matching apartments absent.
 *  - omitted status = unchanged: same rows as the pre-filter list, keyset order.
 *  - the filter is SERVER-SIDE — page size reflects only matching rows (it is
 *    NOT a client-filter over one page): with 30 pending + 1 signed and limit=25,
 *    `status:'signed'` returns exactly the 1 signed (not "0 of this page of 25").
 *  - keyset cursor stays intact UNDER the filter: limit=1 over ≥2 same-status
 *    matches → has_more + cursor; following the cursor yields the next match,
 *    no duplicate, every row the filtered status.
 *  - an out-of-building / cross-tenant apartment never leaks via the filter.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/apartments/apartments-list-filter.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { buildings, withTenant } from '@emapp/db';
import type { ApartmentStatus } from '@emapp/shared-types';
import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
let buildingTeam: string; // hosts the filter-fixture apartments (org A)
let buildingOther: string; // a SECOND building (org A) — must never leak in
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

/** Insert an apartment directly (BYPASS the service) at a known status. */
async function seedApartment(
  buildingId: string,
  status: ApartmentStatus,
  number = `${Math.floor(Math.random() * 1e8)}`,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number, status)
       VALUES ($1, $2, $3) RETURNING id`,
      [buildingId, number, status],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
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

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ApartmentsService(new NotificationsProducerService());
  const tag = `apt-filter-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  orgB = await createTestOrg(`${tag}-b`, `${tag}-b`);
  mgrAId = org.users[0]!.id;
  mgrBId = orgB.users[0]!.id;
  projectTeam = org.projects[0]!.id;

  buildingTeam = await seedBuilding(org.id, projectTeam, mgrAId);
  buildingOther = await seedBuilding(org.id, projectTeam, mgrAId);
  buildingB = await seedBuilding(orgB.id, orgB.projects[0]!.id, mgrBId);
}, 120_000);

afterAll(async () => {
  // Tagged rows are harmless to leave; other suites filter by their own ids.
});

describe('apartments list — additive status filter', () => {
  it('restricts to the exact status; other-status apartments absent', async () => {
    const pendingId = await seedApartment(buildingTeam, 'pending');
    const signedId = await seedApartment(buildingTeam, 'signed');

    const res = await svc.list(managerA(), buildingTeam, { limit: 100, status: 'pending' });
    const ids = res.data.map((a) => a.id);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(signedId);
    // every returned row actually has the requested status
    expect(res.data.every((a) => a.status === 'pending')).toBe(true);
  });

  it('omitted status returns the unchanged list (both statuses present)', async () => {
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    const p = await seedApartment(b, 'pending');
    const s = await seedApartment(b, 'signed');

    const res = await svc.list(managerA(), b, { limit: 100 });
    const ids = res.data.map((a) => a.id);
    expect(ids).toContain(p);
    expect(ids).toContain(s);
    expect(res.page).toHaveProperty('limit', 100);
    expect(res.page).toHaveProperty('has_more');
  });

  it('filter is SERVER-SIDE: 30 pending + 1 signed, limit=25, status=signed → exactly the 1', async () => {
    // A fresh building so the counts are exact and isolated.
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    for (let i = 0; i < 30; i += 1) await seedApartment(b, 'pending');
    const signedId = await seedApartment(b, 'signed');

    // Were this a client-filter over ONE page of 25 keyset rows, the lone signed
    // apartment would frequently fall outside that page → 0 results. Server-side
    // it is found regardless of where it sits in the full ordering.
    const res = await svc.list(managerA(), b, { limit: 25, status: 'signed' });
    expect(res.data.map((a) => a.id)).toEqual([signedId]);
    expect(res.page.has_more).toBe(false);
  });

  it('keyset cursor stays intact UNDER the filter (limit=1 over ≥2 matches, no dup)', async () => {
    const b = await seedBuilding(org.id, projectTeam, mgrAId);
    const m1 = await seedApartment(b, 'meeting');
    const m2 = await seedApartment(b, 'meeting');
    await seedApartment(b, 'pending'); // a non-matching row that must not appear

    const page1 = await svc.list(managerA(), b, { limit: 1, status: 'meeting' });
    expect(page1.data).toHaveLength(1);
    expect(page1.page.has_more).toBe(true);
    expect(page1.page.cursor).toBeTruthy();
    expect(page1.data[0]!.status).toBe('meeting');

    const page2 = await svc.list(managerA(), b, {
      limit: 1,
      status: 'meeting',
      cursor: page1.page.cursor!,
    });
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]!.status).toBe('meeting');
    // the two pages are the two distinct meeting apartments — no duplicate
    const seen = new Set([page1.data[0]!.id, page2.data[0]!.id]);
    expect(seen).toEqual(new Set([m1, m2]));
    expect(page2.page.has_more).toBe(false);
  });

  it('filter never leaks an apartment from another building', async () => {
    const here = await seedApartment(buildingTeam, 'refused');
    const elsewhere = await seedApartment(buildingOther, 'refused');

    const res = await svc.list(managerA(), buildingTeam, { limit: 100, status: 'refused' });
    const ids = res.data.map((a) => a.id);
    expect(ids).toContain(here);
    expect(ids).not.toContain(elsewhere);
  });

  it('filter never leaks across tenants (org-A manager cannot list org-B building)', async () => {
    await seedApartment(buildingB, 'pending');
    // Org A's manager listing an org-B building → 404 (via-parent isolation),
    // not a status-filtered cross-tenant read. The service throws a NestJS
    // NotFoundException; assert its HTTP status via getStatus().
    let caught: unknown;
    try {
      await svc.list(managerA(), buildingB, { limit: 100, status: 'pending' });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'expected a NotFoundException, got none').toBeInstanceOf(NotFoundException);
    expect((caught as NotFoundException).getStatus()).toBe(404);
  });
});
