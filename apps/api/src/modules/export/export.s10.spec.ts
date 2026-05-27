/**
 * V11 Track B.S10 — Export endpoint integration spec (Phase 7).
 *
 * Exercises `ExportComposerService` (the data-side of the endpoint)
 * end-to-end against real Neon + pgcrypto: fixture project with 2
 * buildings, 3 apartments, 4 ownerships across 3 distinct owners,
 * one archived owner (must NOT appear), one ended ownership (must
 * NOT appear). Verifies:
 *
 *   1) Returns the same project the caller asked for, with all
 *      buildings/apartments/owners JOIN'd in.
 *   2) RLS — composer in org A cannot read org B's project (404).
 *   3) Owner PII is decrypted to cleartext at the input boundary
 *      (so renderers don't need to know about pgcrypto).
 *   4) Soft-delete filters: archived owners + ended ownerships
 *      are excluded; archived apartments/buildings are excluded.
 *   5) Empty project (no buildings) still composes a valid input.
 *   6) `project.export` auditLog row is written per call.
 *
 * The full HTTP path (controller + guards + throttle + filename
 * headers + binary streaming) is covered by the curl smoke in the
 * PR description — same pattern as B.S2/B.S5 (service-level here,
 * black-box there).
 */
import {
  apartments,
  auditLog,
  buildings,
  encryptOwnerPii,
  memberships,
  owners,
  ownerships,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, pool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ExportComposerService } from './export-composer.service';

const svc = new ExportComposerService();

let orgA: TestOrg;
let orgB: TestOrg;

const fx = {
  bldA1: '',
  bldA2: '',
  bldEmpty: '',
  aptA1: '',
  aptA2: '',
  aptArchived: '',
  ownDavid: '',
  ownSara: '',
  ownArchived: '',
  emptyProjectId: '',
};

async function makeOwner(
  o: TestOrg,
  args: { name: string; nationalId: string; phone: string; archived?: boolean; email?: string },
): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const enc = await encryptOwnerPii(tx as unknown as Parameters<typeof encryptOwnerPii>[0], {
      name: args.name,
      nationalId: args.nationalId,
      phone: args.phone,
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: o.id,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
        email: args.email ?? null,
        archivedAt: args.archived ? new Date() : null,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function makeBuilding(o: TestOrg, projectIdx = 0, address = 'Default'): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const [row] = await tx
      .insert(buildings)
      .values({
        projectId: o.projects[projectIdx]!.id,
        address: `${address} ${Date.now()}-${Math.random()}`,
        city: 'תל אביב',
        block: '7104',
        parcel: '42',
      })
      .returning({ id: buildings.id });
    return row!.id;
  });
}

async function makeApartment(
  o: TestOrg,
  buildingId: string,
  args?: { number?: string; archived?: boolean },
): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const [row] = await tx
      .insert(apartments)
      .values({
        buildingId,
        number: args?.number ?? `A-${Date.now()}-${Math.random()}`,
        floor: 1,
        archivedAt: args?.archived ? new Date() : null,
      })
      .returning({ id: apartments.id });
    return row!.id;
  });
}

async function makeOwnership(
  o: TestOrg,
  apartmentId: string,
  ownerId: string,
  args?: { pct?: string; ended?: boolean },
): Promise<void> {
  await withTenant(o.id, async (tx) => {
    await tx.insert(ownerships).values({
      apartmentId,
      ownerId,
      ownershipPct: args?.pct ?? '100',
      role: 'owner',
      endedAt: args?.ended ? new Date() : null,
    });
  });
}

/**
 * Insert ALL ownerships for one apartment inside a single withTenant
 * tx so the per-apartment "sum == 100" constraint trigger sees the
 * complete picture at commit time, not partway through.
 */
async function makeOwnershipBundle(
  o: TestOrg,
  apartmentId: string,
  rows: ReadonlyArray<{ ownerId: string; pct: string; ended?: boolean }>,
): Promise<void> {
  await withTenant(o.id, async (tx) => {
    for (const r of rows) {
      await tx.insert(ownerships).values({
        apartmentId,
        ownerId: r.ownerId,
        ownershipPct: r.pct,
        role: 'owner',
        endedAt: r.ended ? new Date() : null,
      });
    }
  });
}

function userOf(o: TestOrg, role: 'manager' | 'agent' | 'viewer' = 'manager'): AccessTokenPayload {
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role,
    // sid must be a valid UUID — audit_log.session_id is `uuid` typed
    // and pg validates at the parameter binding layer.
    sid: '00000000-0000-0000-0000-000000000000',
    type: 'access',
    iat: 0,
    exp: 0,
  } as unknown as AccessTokenPayload;
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`B10A-${ts}`, `b10a-${ts}`);
  orgB = await createTestOrg(`B10B-${ts}`, `b10b-${ts}`);

  // Owners — david + sara are active, "archived" is soft-deleted.
  fx.ownDavid = await makeOwner(orgA, {
    name: 'דוד כהן',
    nationalId: '300000010',
    phone: '0501110001',
    email: 'david@example.com',
  });
  fx.ownSara = await makeOwner(orgA, {
    name: 'שרה לוי',
    nationalId: '300000020',
    phone: '0501110002',
    email: 'sara@example.com',
  });
  fx.ownArchived = await makeOwner(orgA, {
    name: 'archived',
    nationalId: '300000030',
    phone: '0501110003',
    archived: true,
  });

  // Buildings — bldA1 has apts, bldA2 has one apt + one ARCHIVED apt,
  // bldEmpty has none (gap detection).
  fx.bldA1 = await makeBuilding(orgA, 0, 'בלד א1');
  fx.bldA2 = await makeBuilding(orgA, 0, 'בלד א2');
  fx.bldEmpty = await makeBuilding(orgA, 0, 'בלד ריק');

  fx.aptA1 = await makeApartment(orgA, fx.bldA1, { number: '1' });
  fx.aptA2 = await makeApartment(orgA, fx.bldA2, { number: '2' });
  fx.aptArchived = await makeApartment(orgA, fx.bldA2, { number: '99', archived: true });

  // Ownerships: aptA1 has david(50%) + sara(50%); aptA2 has david(100%).
  // Per-apartment sum-to-100 constraint trigger requires the inserts
  // for one apartment to land in a single tx — use the bundle helper.
  await makeOwnershipBundle(orgA, fx.aptA1, [
    { ownerId: fx.ownDavid, pct: '50' },
    { ownerId: fx.ownSara, pct: '50' },
  ]);
  await makeOwnership(orgA, fx.aptA2, fx.ownDavid, { pct: '100' });

  // ENDED ownership on the archived owner — sits on aptA1 but is
  // already inactive (endedAt set) so the sum-to-100 trigger
  // shouldn't recompute. Using a tiny pct (0) so even if the
  // trigger DID consider it, the active rows still hit 100.
  await makeOwnership(orgA, fx.aptA1, fx.ownArchived, { pct: '0', ended: true });

  // Org B — separate project for cross-tenant test (RLS gate).
  // createTestOrg already created projects[0] in orgB; we'll just
  // try to query orgB's projects[0] as orgA's user.

  // Empty project — exists in orgA but has zero buildings.
  fx.emptyProjectId = orgA.projects[1]!.id;
}, 60_000);

afterAll(async () => {
  /* pool teardown via globalSetup */
  void pool;
});

describe('V11 B.S10 · ExportComposerService — project export (Phase 7)', () => {
  it('1) composes the full project tree with active buildings + apartments + (sara, david) owners decrypted to cleartext', async () => {
    const { input, rowCount } = await svc.composeProjectExport(
      userOf(orgA),
      orgA.projects[0]!.id,
      'xlsx',
    );
    expect(input.project.id).toBe(orgA.projects[0]!.id);
    expect(input.buildings).toHaveLength(3); // bldA1 + bldA2 + bldEmpty
    const bldA1 = input.buildings.find((b) => b.id === fx.bldA1)!;
    const bldA2 = input.buildings.find((b) => b.id === fx.bldA2)!;
    const bldEmpty = input.buildings.find((b) => b.id === fx.bldEmpty)!;
    expect(bldA1.apartments).toHaveLength(1);
    // bldA2 has aptA2 + aptArchived. Archived must be filtered out → 1.
    expect(bldA2.apartments).toHaveLength(1);
    expect(bldEmpty.apartments).toHaveLength(0);

    // aptA1 owners: david + sara — both decrypted to cleartext.
    const a1 = bldA1.apartments[0]!;
    expect(a1.owners).toHaveLength(2);
    const a1Names = a1.owners.map((o) => o.name).sort();
    expect(a1Names).toEqual(['דוד כהן', 'שרה לוי']);
    // PII is cleartext at this boundary.
    const davidOnA1 = a1.owners.find((o) => o.name === 'דוד כהן')!;
    expect(davidOnA1.nationalId).toBe('300000010');
    expect(davidOnA1.phone).toBe('0501110001');
    expect(davidOnA1.email).toBe('david@example.com');
    expect(davidOnA1.ownershipPct).toBe(50);

    // aptA2 owner: david(100%) only.
    const a2 = bldA2.apartments[0]!;
    expect(a2.owners).toHaveLength(1);
    expect(a2.owners[0]!.name).toBe('דוד כהן');
    expect(a2.owners[0]!.ownershipPct).toBe(100);

    // rowCount = total (apartment, owner) tuples = david-on-A1 +
    // sara-on-A1 + david-on-A2 = 3.
    expect(rowCount).toBe(3);
  });

  it('2) RLS — composer in org A cannot read org B project (NotFoundException)', async () => {
    await expect(
      svc.composeProjectExport(userOf(orgA), orgB.projects[0]!.id, 'xlsx'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('2b) agent without an active project_assignments row → 404 (D.17 scope-to-assigned)', async () => {
    // Create an agent user in orgA + a membership but NO project assignment.
    // Uses the bare `db` (no RLS) — matches the pattern factories.ts uses
    // for org/user/membership setup, since RLS on users + memberships is
    // managed via the provider tier, not the app_user tenant scope.
    const [u] = await db
      .insert(users)
      .values({
        email: `agent-noassign-${Date.now()}-${Math.random()}@test.local`,
        name: 'Unassigned Agent',
        passwordHash: '$2b$12$placeholder',
      })
      .returning({ id: users.id });
    await db.insert(memberships).values({
      userId: u!.id,
      orgId: orgA.id,
      role: 'agent',
      isPrimary: false,
      acceptedAt: new Date(),
    });
    const agentUserId = u!.id;
    const agentPayload: AccessTokenPayload = {
      sub: agentUserId,
      orgId: orgA.id,
      role: 'agent',
      sid: '00000000-0000-0000-0000-000000000000',
      type: 'access',
      iat: 0,
      exp: 0,
    } as unknown as AccessTokenPayload;
    await expect(
      svc.composeProjectExport(agentPayload, orgA.projects[0]!.id, 'xlsx'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('2c) agent WITH an active project_assignments row → composes the project (positive scope test)', async () => {
    const [u] = await db
      .insert(users)
      .values({
        email: `agent-assigned-${Date.now()}-${Math.random()}@test.local`,
        name: 'Assigned Agent',
        passwordHash: '$2b$12$placeholder',
      })
      .returning({ id: users.id });
    await db.insert(memberships).values({
      userId: u!.id,
      orgId: orgA.id,
      role: 'agent',
      isPrimary: false,
      acceptedAt: new Date(),
    });
    // project_assignments IS tenant-RLS-scoped — insert via withTenant
    // so the org_id GUC matches the parent project's org.
    await withTenant(orgA.id, async (tx) => {
      await tx.insert(projectAssignments).values({
        projectId: orgA.projects[0]!.id,
        userId: u!.id,
        roleInProject: 'agent',
        assignedBy: orgA.users[0]!.id,
      });
    });
    const agentUserId = u!.id;
    const assignedProjectId = orgA.projects[0]!.id;
    const agentPayload: AccessTokenPayload = {
      sub: agentUserId,
      orgId: orgA.id,
      role: 'agent',
      sid: '00000000-0000-0000-0000-000000000000',
      type: 'access',
      iat: 0,
      exp: 0,
    } as unknown as AccessTokenPayload;
    const { input } = await svc.composeProjectExport(agentPayload, assignedProjectId, 'xlsx');
    expect(input.project.id).toBe(assignedProjectId);
    // The full sub-tree should still be readable (agent gets the SAME
    // payload as a manager once visibility is granted).
    expect(input.buildings.length).toBeGreaterThan(0);
  });

  it('3) archived owner + ended ownership are filtered out (no leak via archived owner row)', async () => {
    const { input } = await svc.composeProjectExport(userOf(orgA), orgA.projects[0]!.id, 'xlsx');
    const a1 = input.buildings.find((b) => b.id === fx.bldA1)!.apartments[0]!;
    // archived owner ownership was also ENDED — must not appear.
    expect(a1.owners.find((o) => o.name === 'archived')).toBeUndefined();
    // No owner should have id matching fx.ownArchived (defence-in-depth).
    // (owners don't carry id at this boundary, but national_id is a
    // proxy.)
    expect(a1.owners.find((o) => o.nationalId === '300000030')).toBeUndefined();
  });

  it('4) empty project (zero buildings) composes a valid input with empty buildings []', async () => {
    const { input, rowCount } = await svc.composeProjectExport(
      userOf(orgA),
      fx.emptyProjectId,
      'pdf',
    );
    expect(input.project.id).toBe(fx.emptyProjectId);
    expect(input.buildings).toEqual([]);
    expect(rowCount).toBe(0);
  });

  it('5) auditLog — writes one `project.export` row per call with action + targetId + afterState.format', async () => {
    const before = await withTenant(orgA.id, (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'project.export'), eq(auditLog.targetId, orgA.projects[0]!.id)),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(5),
    );
    const beforeCount = before.length;
    await svc.composeProjectExport(userOf(orgA), orgA.projects[0]!.id, 'pdf');
    const after = await withTenant(orgA.id, (tx) =>
      tx
        .select({
          id: auditLog.id,
          action: auditLog.action,
          targetId: auditLog.targetId,
          afterState: auditLog.afterState,
        })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'project.export'), eq(auditLog.targetId, orgA.projects[0]!.id)),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(beforeCount + 1),
    );
    expect(after.length).toBeGreaterThan(beforeCount);
    const newest = after[0]!;
    expect(newest.action).toBe('project.export');
    expect(newest.targetId).toBe(orgA.projects[0]!.id);
    expect((newest.afterState as { format?: string }).format).toBe('pdf');
  });
});
