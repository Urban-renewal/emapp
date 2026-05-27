/**
 * V11 Track B.S1 (canary) — building_sections + apartments.unit_type
 * schema invariants (migration 0035, D.39).
 *
 * What this pins
 * ──────────────
 * Template B RLS via parent (sections → buildings → projects → org GUC),
 * the no-DELETE grant for app_user, and the additive apartments columns
 * (unit_type default 'apt', area_sqm + entrance nullable). These are the
 * contract the AddProjectModal wizard (Track A.S6 via B.S2) will rely on.
 *
 *   1. RLS USING — section in Org A is invisible to Org B
 *   2. RLS WITH CHECK — Org B cannot insert a section into Org A's building
 *   3. GRANT — app_user has no DELETE on building_sections
 *   4. apartments — unit_type defaults to 'apt'; non-residential values + area_sqm + entrance accepted
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';
import { apartments, buildingSections, buildings } from '../src/schema/projects';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

let orgA: TestOrg;
let orgB: TestOrg;
let buildingAId: string;

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`SECA-${ts}`, `seca-${ts}`);
  orgB = await createTestOrg(`SECB-${ts}`, `secb-${ts}`);

  // One building per org under its first project — used as the parent
  // for sections + apartments throughout the suite.
  buildingAId = await withTenant(orgA.id, async (tx) => {
    const [bld] = await tx
      .insert(buildings)
      .values({
        projectId: orgA.projects[0]!.id,
        address: `Section St ${ts}`,
        city: 'Tel Aviv',
      })
      .returning({ id: buildings.id });
    return bld!.id;
  });

  await withTenant(orgB.id, async (tx) => {
    await tx.insert(buildings).values({
      projectId: orgB.projects[0]!.id,
      address: `Section St ${ts} (B)`,
      city: 'Tel Aviv',
    });
  });
});

afterAll(async () => {
  /* pool teardown handled by global-setup */
  void pool;
});

async function expectPgError(
  promise: Promise<unknown>,
  expected: { code?: string; messageMatches?: RegExp },
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected promise to reject').toBeDefined();
  let cur: unknown = caught;
  let depth = 0;
  while (cur && depth < 8) {
    const pg = cur as { code?: string; message?: string };
    if (expected.code && pg.code === expected.code) return;
    if (expected.messageMatches && pg.message && expected.messageMatches.test(pg.message)) return;
    cur = (cur as { cause?: unknown })?.cause;
    depth += 1;
  }
  throw new Error(
    `pg error did not match. Looked for ${JSON.stringify(expected)}. ` +
      `Got: ${caught instanceof Error ? caught.message : String(caught)}`,
  );
}

describe('V11 B.S1 · building_sections + apartments.unit_type — D.39 schema', () => {
  it('1) RLS USING — section in Org A is invisible to Org B', async () => {
    const [section] = await withTenant(orgA.id, async (tx) =>
      tx
        .insert(buildingSections)
        .values({
          buildingId: buildingAId,
          kind: 'residential',
          floors: 4,
          unitCount: 8,
          entrance: 'א',
          gush: '6925',
          helka: '12',
        })
        .returning({ id: buildingSections.id }),
    );
    expect(section?.id).toBeDefined();

    const visibleToB = await withTenant(orgB.id, async (tx) =>
      tx
        .select({ id: buildingSections.id })
        .from(buildingSections)
        .where(eq(buildingSections.id, section!.id)),
    );
    expect(visibleToB).toHaveLength(0);

    const visibleToA = await withTenant(orgA.id, async (tx) =>
      tx
        .select({ id: buildingSections.id })
        .from(buildingSections)
        .where(eq(buildingSections.id, section!.id)),
    );
    expect(visibleToA).toHaveLength(1);
  });

  it('2) RLS WITH CHECK — Org B cannot insert a section into Org A’s building', async () => {
    await expectPgError(
      withTenant(orgB.id, async (tx) =>
        tx.insert(buildingSections).values({
          buildingId: buildingAId,
          kind: 'office',
        }),
      ),
      { code: '42501', messageMatches: /row-level security|policy/i },
    );
  });

  it('3) GRANT — app_user has no DELETE on building_sections', async () => {
    await expectPgError(
      withTenant(orgA.id, async (tx) => {
        await tx.execute(sql`DELETE FROM building_sections WHERE id = gen_random_uuid()`);
      }),
      { code: '42501', messageMatches: /permission denied/i },
    );
  });

  it('4) apartments — unit_type defaults to apt; non-residential values + area_sqm + entrance accepted', async () => {
    const tagDefault = `D-${Date.now()}`;
    const tagShop = `S-${Date.now()}`;
    await withTenant(orgA.id, async (tx) => {
      await tx.insert(apartments).values({ buildingId: buildingAId, number: tagDefault });
      await tx.insert(apartments).values({
        buildingId: buildingAId,
        number: tagShop,
        unitType: 'shop',
        areaSqm: '85.50',
        entrance: 'ב',
      });
    });

    const rows = await withTenant(orgA.id, async (tx) =>
      tx
        .select({
          number: apartments.number,
          unitType: apartments.unitType,
          areaSqm: apartments.areaSqm,
          entrance: apartments.entrance,
        })
        .from(apartments)
        .where(eq(apartments.buildingId, buildingAId)),
    );

    const aptDefault = rows.find((r) => r.number === tagDefault);
    const aptShop = rows.find((r) => r.number === tagShop);
    expect(aptDefault?.unitType).toBe('apt');
    expect(aptDefault?.areaSqm).toBeNull();
    expect(aptDefault?.entrance).toBeNull();
    expect(aptShop?.unitType).toBe('shop');
    expect(aptShop?.areaSqm).toBe('85.50');
    expect(aptShop?.entrance).toBe('ב');
  });
});
