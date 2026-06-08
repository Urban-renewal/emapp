/**
 * D.39 — apartment `unit_type` persistence (real-DB, adversarial).
 *
 * Independent TEST-AUTHOR suite — does NOT trust the builder. Drives the
 * REAL `ApartmentsService` against a real DB (no HTTP, so no signup 429
 * throttle: the org + building are seeded directly via factories / providerPool,
 * exactly like apartments-notify.spec.ts).
 *
 * Load-bearing claims (each a mutation guard on apartments.service.ts):
 *   UT-1 CREATE { unitType:'shop' } → the persisted row's unit_type IS 'shop'.
 *        FAILS if the service drops `unitType` on insert (column DEFAULT 'apt'
 *        would otherwise mask the bug).
 *   UT-2 CREATE with NO unitType → defaults to 'apt' (service `?? 'apt'` +
 *        the column's NOT NULL DEFAULT 'apt').
 *   UT-3 PATCH { status } ONLY (no unitType) → unit_type UNCHANGED. Proves the
 *        `input.unitType !== undefined` no-op guard — FAILS if PATCH ever
 *        writes a fallback over an existing commercial unit.
 *   UT-4 PATCH { unitType:'office' } → unit_type updated to 'office'.
 *
 * Ground truth for unit_type is read TWO ways: through the service `get()`
 * wire-shape AND straight from the column via providerPool (BYPASSRLS), so a
 * mapper that lies can't fool the assertion.
 */
import { buildings, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { ApartmentsService } from './apartments.service';

let svc: ApartmentsService;
let org: TestOrg;
let manager: string;
let buildingId: string;

const SID = '00000000-0000-4000-8000-0000000000c0';

function payload(sub: string): AccessTokenPayload {
  return {
    sub,
    orgId: org.id,
    role: 'manager',
    sid: SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

/** Read unit_type straight from the column (BYPASSRLS) — ground truth. */
async function rawUnitType(apartmentId: string): Promise<string | null> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ unit_type: string | null }>(
      `SELECT unit_type FROM apartments WHERE id = $1`,
      [apartmentId],
    );
    return r.rows[0] ? r.rows[0].unit_type : null;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ApartmentsService(new NotificationsProducerService());
  const tag = `apt-unittype-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  manager = org.users[0]!.id;
  const projectId = org.projects[0]!.id;

  buildingId = await withTenant(
    org.id,
    async (tx) => {
      const [b] = await tx
        .insert(buildings)
        .values({ projectId, address: 'Herzl 10', city: 'TLV' })
        .returning({ id: buildings.id });
      return b!.id;
    },
    { userId: manager },
  );
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('D.39 — apartment unit_type persistence', () => {
  it('UT-1) CREATE { unitType:"shop" } persists unit_type="shop" (service does NOT drop it)', async () => {
    const created = await svc.create(payload(manager), buildingId, {
      number: `${Math.floor(Math.random() * 1e7)}`,
      unitType: 'shop',
    });
    // wire-shape carries it…
    expect(created.unitType).toBe('shop');
    // …and so does the actual column (mutation guard vs a dropped insert).
    expect(await rawUnitType(created.id)).toBe('shop');
    // re-read through the service get() path too.
    const got = await svc.get(payload(manager), created.id);
    expect(got.unitType).toBe('shop');
  }, 30_000);

  it('UT-1b) CREATE persists each non-default unit type verbatim (office, mixed)', async () => {
    for (const u of ['office', 'mixed'] as const) {
      const created = await svc.create(payload(manager), buildingId, {
        number: `${Math.floor(Math.random() * 1e7)}`,
        unitType: u,
      });
      expect(created.unitType, `wire unitType for ${u}`).toBe(u);
      // eslint-disable-next-line no-await-in-loop
      expect(await rawUnitType(created.id), `column unit_type for ${u}`).toBe(u);
    }
  }, 30_000);

  it('UT-2) CREATE with NO unitType → defaults to "apt"', async () => {
    const created = await svc.create(payload(manager), buildingId, {
      number: `${Math.floor(Math.random() * 1e7)}`,
    });
    expect(created.unitType).toBe('apt');
    expect(await rawUnitType(created.id)).toBe('apt');
  }, 30_000);

  it('UT-3) PATCH { status } ONLY (no unitType) → unit_type UNCHANGED (no-op guard)', async () => {
    // Seed a SHOP, then PATCH only the status. If the service ever wrote a
    // fallback on every update, the shop would silently revert to 'apt'.
    const created = await svc.create(payload(manager), buildingId, {
      number: `${Math.floor(Math.random() * 1e7)}`,
      unitType: 'shop',
    });
    expect(await rawUnitType(created.id)).toBe('shop');

    const patched = await svc.update(payload(manager), created.id, { status: 'contacted' });
    expect(patched.status).toBe('contacted');
    // unit_type must be untouched by a unitType-free PATCH.
    expect(patched.unitType, 'PATCH without unitType reset the column').toBe('shop');
    expect(await rawUnitType(created.id)).toBe('shop');
  }, 30_000);

  it('UT-3b) PATCH { notes } ONLY → unit_type still UNCHANGED for a mixed unit', async () => {
    const created = await svc.create(payload(manager), buildingId, {
      number: `${Math.floor(Math.random() * 1e7)}`,
      unitType: 'mixed',
    });
    const patched = await svc.update(payload(manager), created.id, { notes: 'walk-up' });
    expect(patched.notes).toBe('walk-up');
    expect(patched.unitType).toBe('mixed');
    expect(await rawUnitType(created.id)).toBe('mixed');
  }, 30_000);

  it('UT-4) PATCH { unitType:"office" } → unit_type updated to "office"', async () => {
    // Start from the 'apt' default, then explicitly move it to office.
    const created = await svc.create(payload(manager), buildingId, {
      number: `${Math.floor(Math.random() * 1e7)}`,
    });
    expect(await rawUnitType(created.id)).toBe('apt');

    const patched = await svc.update(payload(manager), created.id, { unitType: 'office' });
    expect(patched.unitType).toBe('office');
    expect(await rawUnitType(created.id)).toBe('office');
  }, 30_000);
});
