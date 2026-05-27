/**
 * V11 Track B.S2 — ProjectsService.create wizard expansion (D.39).
 *
 * The AddProjectModal 3-step wizard (Track A.S6 consumer) sends ONE
 * atomic request with project + buildings + sections + apartments;
 * the BE expands them inside a single withTenant tx so partial state
 * is impossible. This service-level integration spec pins:
 *
 *   1. Back-compat — no `buildings` field still works exactly as
 *      before; audit row carries 0-counts (shape stays stable).
 *   2. Happy-path nested — project + buildings + sections + apartments
 *      all land, reading back via withTenant sees the full tree, audit
 *      row carries accurate counts.
 *   3. Atomicity — a duplicate apartments.number under the same
 *      building (unique index violation, migration 0001) throws and
 *      ZERO rows persist (including the project itself).
 *   4. RLS isolation — Org B cannot see Org A's nested rows after a
 *      wizard create (Template B chain still applies to building_sections).
 *   5. Audit row shape — afterState carries the 3 count fields whether
 *      they're 0 or non-0.
 *
 * Same pattern as imports.s8.spec.ts: instantiate the service directly,
 * hit real Neon for RLS/audit invariants, no Nest harness.
 */
import { apartments, auditLog, buildings, buildingSections, projects, withTenant } from '@emapp/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

let orgA: TestOrg;
let orgB: TestOrg;
const svc = new ProjectsService();

// Stable session UUID (matches audit_log.session_id type).
const TEST_SID = '00000000-0000-4000-8000-00000000bbb1';

function userOf(
  o: TestOrg,
  role: 'manager' | 'agent' | 'viewer' = 'manager',
  userIdx = 0,
): AccessTokenPayload {
  return {
    sub: o.users[userIdx]!.id,
    orgId: o.id,
    role,
    sid: TEST_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`B2A-${ts}`, `b2a-${ts}`);
  orgB = await createTestOrg(`B2B-${ts}`, `b2b-${ts}`);
});

afterAll(async () => {
  /* pool teardown handled by global-setup */
});

describe('V11 B.S2 · ProjectsService.create wizard expansion (D.39)', () => {
  it('1) back-compat: input without `buildings` still works; audit counts all 0', async () => {
    const proj = await svc.create(userOf(orgA), {
      name: `B.S2 back-compat ${Date.now()}`,
      type: 'tama38_1',
    });
    expect(proj.id).toBeDefined();
    expect(proj.organizationId).toBe(orgA.id);

    const [childBuildings, audit] = await Promise.all([
      withTenant(orgA.id, async (tx) =>
        tx.select({ id: buildings.id }).from(buildings).where(eq(buildings.projectId, proj.id)),
      ),
      withTenant(orgA.id, async (tx) =>
        tx
          .select({ afterState: auditLog.afterState })
          .from(auditLog)
          .where(and(eq(auditLog.action, 'project.create'), eq(auditLog.targetId, proj.id)))
          .limit(1),
      ),
    ]);

    expect(childBuildings).toHaveLength(0);
    const after = audit[0]?.afterState as Record<string, unknown> | undefined;
    expect(after?.['buildingsCreated']).toBe(0);
    expect(after?.['sectionsCreated']).toBe(0);
    expect(after?.['apartmentsCreated']).toBe(0);
  });

  it('2) happy-path nested: project + 1 building + 2 sections + 3 apartments all land', async () => {
    const proj = await svc.create(userOf(orgA), {
      name: `B.S2 nested ${Date.now()}`,
      type: 'pinui_binui',
      buildings: [
        {
          address: "דה פיג'וטו 9",
          city: 'תל אביב',
          // Building-level parcel = `block`/`parcel`/`subparcel` (DB columns
          // pre-V11). Section-level may also carry its own `gush`/`helka`
          // (D.39) — see the section literal below.
          block: '6925',
          parcel: '12',
          sections: [
            {
              kind: 'residential',
              entrance: 'א',
              floors: 4,
              unitCount: 8,
              gush: '6925',
              helka: '12',
            },
            { kind: 'retail', entrance: 'B-ground', floors: 1, unitCount: 2 },
          ],
          apartments: [
            { number: '1', floor: 1, rooms: 3.5, sizeSqm: 75, unitType: 'apt' },
            { number: '2', floor: 1, rooms: 4, sizeSqm: 88, areaSqm: 92, unitType: 'apt' },
            { number: 'shop-1', floor: 0, unitType: 'shop', entrance: 'B-ground' },
          ],
        },
      ],
    });

    const [bldRows, secRows, aptRows, auditRows] = await Promise.all([
      withTenant(orgA.id, async (tx) =>
        tx
          .select({ id: buildings.id, address: buildings.address, aptCount: buildings.aptCount })
          .from(buildings)
          .where(eq(buildings.projectId, proj.id)),
      ),
      withTenant(orgA.id, async (tx) =>
        tx
          .select({
            id: buildingSections.id,
            kind: buildingSections.kind,
            entrance: buildingSections.entrance,
            buildingId: buildingSections.buildingId,
          })
          .from(buildingSections),
      ),
      withTenant(orgA.id, async (tx) =>
        tx
          .select({
            number: apartments.number,
            unitType: apartments.unitType,
            entrance: apartments.entrance,
          })
          .from(apartments),
      ),
      withTenant(orgA.id, async (tx) =>
        tx
          .select({ afterState: auditLog.afterState })
          .from(auditLog)
          .where(and(eq(auditLog.action, 'project.create'), eq(auditLog.targetId, proj.id)))
          .limit(1),
      ),
    ]);

    expect(bldRows).toHaveLength(1);
    expect(bldRows[0]?.address).toBe("דה פיג'וטו 9");
    // `apt_count` is maintained by trg_apartments_count_maintenance
    // (migration 0002) — it increments per non-archived apartment
    // INSERT. After our 3 apartment inserts, expect exactly 3.
    expect(bldRows[0]?.aptCount).toBe(3);

    // Filter to the building we just created (orgA may have prior buildings
    // from other tests in this suite).
    const ourSections = secRows.filter((s) => s.buildingId === bldRows[0]!.id);
    expect(ourSections).toHaveLength(2);
    expect(ourSections.map((s) => s.kind).sort()).toEqual(['residential', 'retail']);

    const ourApts = aptRows.filter(
      (a) => a.number === '1' || a.number === '2' || a.number === 'shop-1',
    );
    expect(ourApts).toHaveLength(3);
    expect(ourApts.find((a) => a.number === 'shop-1')?.unitType).toBe('shop');
    expect(ourApts.find((a) => a.number === '1')?.unitType).toBe('apt');

    const after = auditRows[0]?.afterState as Record<string, unknown> | undefined;
    expect(after?.['buildingsCreated']).toBe(1);
    expect(after?.['sectionsCreated']).toBe(2);
    expect(after?.['apartmentsCreated']).toBe(3);
  });

  it('3) atomicity: duplicate apartment.number under the same building → ZERO rows persist (project + building + sections all rolled back)', async () => {
    const uniqueName = `B.S2 atomic-rollback ${Date.now()}`;
    await expect(
      svc.create(userOf(orgA), {
        name: uniqueName,
        type: 'tama38_2',
        buildings: [
          {
            address: 'Rollback St',
            city: 'Haifa',
            sections: [{ kind: 'residential', floors: 2 }],
            apartments: [
              // Duplicate `number` in the same building triggers the
              // apartments_building_number_active unique index (0001) AFTER
              // the project + building + section all inserted. The tx
              // rolls back, so the project row must NOT survive.
              { number: 'A-1' },
              { number: 'A-1' },
            ],
          },
        ],
      }),
    ).rejects.toThrow();

    const survivors = await withTenant(orgA.id, async (tx) =>
      tx.select({ id: projects.id }).from(projects).where(eq(projects.name, uniqueName)),
    );
    expect(survivors).toHaveLength(0);
  });

  it('4) RLS isolation — Org B cannot see Org A’s nested rows after wizard create', async () => {
    const proj = await svc.create(userOf(orgA), {
      name: `B.S2 rls ${Date.now()}`,
      type: 'tama38_1',
      buildings: [
        {
          address: 'Isolation Ln',
          city: 'Tel Aviv',
          sections: [{ kind: 'office', floors: 3 }],
          apartments: [{ number: 'X-1', unitType: 'office' }],
        },
      ],
    });

    const [bldFromB, secFromB, aptFromB] = await Promise.all([
      withTenant(orgB.id, async (tx) =>
        tx.select({ id: buildings.id }).from(buildings).where(eq(buildings.projectId, proj.id)),
      ),
      withTenant(orgB.id, async (tx) =>
        tx
          .select({ id: buildingSections.id })
          .from(buildingSections)
          .where(eq(buildingSections.kind, 'office')),
      ),
      withTenant(orgB.id, async (tx) =>
        tx
          .select({ number: apartments.number })
          .from(apartments)
          .where(eq(apartments.number, 'X-1')),
      ),
    ]);

    expect(bldFromB).toHaveLength(0);
    // Org B might have its own 'office' sections; assert OUR section's id
    // is not in the visible set (no oracle).
    const orgASections = await withTenant(orgA.id, async (tx) =>
      tx
        .select({ id: buildingSections.id })
        .from(buildingSections)
        .where(eq(buildingSections.kind, 'office')),
    );
    const orgASectionIds = new Set(orgASections.map((s) => s.id));
    for (const s of secFromB) {
      expect(orgASectionIds.has(s.id)).toBe(false);
    }
    // Org A's 'X-1' apartment is not visible to Org B (no other org
    // would happen to use the same string).
    expect(aptFromB).toHaveLength(0);
  });

  it('5) RBAC — viewer rejected (ForbiddenException), agent rejected', async () => {
    const viewerInput = { name: `viewer ${Date.now()}`, type: 'tama38_1' as const };
    await expect(svc.create(userOf(orgA, 'viewer'), viewerInput)).rejects.toThrow(/forbidden/i);
    await expect(svc.create(userOf(orgA, 'agent'), viewerInput)).rejects.toThrow(/forbidden/i);
  });
});
