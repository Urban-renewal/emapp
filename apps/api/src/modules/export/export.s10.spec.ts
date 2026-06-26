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
  authSessions,
  buildings,
  encryptOwnerPii,
  memberPermissionOverrides,
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

/**
 * B6 — create a real `auth_sessions` row for the org's user and return a
 * payload whose `sid` points at it. `unlocked: true` stamps `pii_unlocked_at`
 * now() (a VALID step-up unlock); `false`/omitted leaves it NULL (locked).
 * auth_sessions is auth-infra (no RLS), so we use the bare `db` — same
 * pattern the factories use for user/membership setup.
 */
async function makeSessionUser(
  o: TestOrg,
  opts: { unlocked?: boolean; unlockedAt?: Date } = {},
): Promise<AccessTokenPayload> {
  const [sess] = await db
    .insert(authSessions)
    .values({
      userId: o.users[0]!.id,
      tokenHash: `b6-${Date.now()}-${Math.random()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      piiUnlockedAt: opts.unlocked ? (opts.unlockedAt ?? new Date()) : null,
    })
    .returning({ id: authSessions.id });
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role: 'manager',
    sid: sess!.id,
    type: 'access',
    iat: 0,
    exp: 0,
  } as unknown as AccessTokenPayload;
}

/**
 * B5/B6 — strip `owners.reveal_pii` from the org's user via a real org-scoped
 * DENY override, WITHOUT touching `export.run`. This reproduces the production
 * defect state EXACTLY: a Manager (who at signup holds BOTH reveal_pii AND
 * export.run on the system role) is moved to a posture where the live engine no
 * longer resolves `owners.reveal_pii` for them, while `export.run` (the export
 * controller's @RequirePermission) still resolves. `export.run` does NOT imply
 * `owners.reveal_pii` (`permissions.ts`), and the two are DISCRETE removable
 * permissions (`system-roles.ts`), so the engine returns export+read but NOT
 * reveal-PII — precisely the role whose stale `pii_unlocked_at` must NOT serve
 * cleartext. The DENY is subtracted AFTER implication-expansion, so it removes
 * EXACTLY reveal_pii and leaves export.run/owners.read intact.
 *
 * memberPermissionOverrides is RLS-scoped to the org → write it inside
 * withTenant so the request-path resolver (which reads under withTenant) sees it.
 */
async function revokeRevealPii(o: TestOrg): Promise<void> {
  await withTenant(o.id, async (tx) => {
    await tx
      .insert(memberPermissionOverrides)
      .values({
        userId: o.users[0]!.id,
        permission: 'owners.reveal_pii',
        effect: 'deny',
        scopeType: 'org',
        scopeId: o.id,
      })
      .onConflictDoNothing();
  });
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
  it('1) composes the full project tree with active buildings + apartments + (sara, david) owners; national_id/phone MASKED', async () => {
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

    // aptA1 owners: david + sara. name + email are cleartext at this boundary
    // (not classified PII); D.54 — national_id/phone are MASKED in the export
    // (reveal-on-demand only).
    const a1 = bldA1.apartments[0]!;
    expect(a1.owners).toHaveLength(2);
    const a1Names = a1.owners.map((o) => o.name).sort();
    expect(a1Names).toEqual(['דוד כהן', 'שרה לוי']);
    const davidOnA1 = a1.owners.find((o) => o.name === 'דוד כהן')!;
    expect(davidOnA1.nationalId).toBe('•••••••10'); // masked (was cleartext pre-D.54)
    expect(davidOnA1.phone).toBe('•••••0001'); // masked last-4
    expect(davidOnA1.email).toBe('david@example.com'); // email is not masked PII
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
    // Wave 5 E-C3 (errors audit 2026-05-28): the 404 envelope MUST
    // include both `code` and `message` per D.16. The cross-org case
    // shares the "project not found" message with a missing-project
    // case (no oracle — both collapse to the same response).
    await expect(
      svc.composeProjectExport(userOf(orgA), orgB.projects[0]!.id, 'xlsx'),
    ).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'not_found', message: 'project not found' } },
    });
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
    // The full sub-tree is readable once visibility is granted…
    expect(input.buildings.length).toBeGreaterThan(0);
    // …but D.54 — an agent WITHOUT view_owner_pii (default) exports MASKED
    // owner PII, NOT cleartext. The export reflects the actor's on-screen
    // fidelity (D.50); this closes the prior bypass where every export caller
    // got cleartext national_id/phone regardless of capability.
    const allOwners = input.buildings.flatMap((b) => b.apartments.flatMap((a) => a.owners));
    expect(allOwners.length).toBeGreaterThan(0);
    for (const o of allOwners) {
      expect(o.nationalId!.startsWith('•')).toBe(true);
      expect(o.nationalId).not.toBe('300000010'); // David — no cleartext leak
      if (o.phone != null) expect(o.phone.startsWith('•')).toBe(true);
    }
  });

  it('2d) agent WITH view_owner_pii → export is STILL MASKED (reveal-on-demand, never bulk)', async () => {
    const [u] = await db
      .insert(users)
      .values({
        email: `agent-pii-${Date.now()}-${Math.random()}@test.local`,
        name: 'PII Agent',
        passwordHash: '$2b$12$placeholder',
      })
      .returning({ id: users.id });
    await db.insert(memberships).values({
      userId: u!.id,
      orgId: orgA.id,
      role: 'agent',
      isPrimary: false,
      acceptedAt: new Date(),
      capabilities: {
        edit_project_data: false,
        manage_documents: false,
        run_imports: false,
        manage_signatures: false,
        manage_tasks: false,
        view_owners: true,
        view_owner_pii: true,
      },
    });
    await withTenant(orgA.id, async (tx) => {
      await tx.insert(projectAssignments).values({
        projectId: orgA.projects[0]!.id,
        userId: u!.id,
        roleInProject: 'agent',
        assignedBy: orgA.users[0]!.id,
      });
    });
    const agentPayload: AccessTokenPayload = {
      sub: u!.id,
      orgId: orgA.id,
      role: 'agent',
      sid: '00000000-0000-0000-0000-000000000000',
      type: 'access',
      iat: 0,
      exp: 0,
    } as unknown as AccessTokenPayload;
    const { input } = await svc.composeProjectExport(agentPayload, orgA.projects[0]!.id, 'xlsx');
    const allOwners = input.buildings.flatMap((b) => b.apartments.flatMap((a) => a.owners));
    expect(allOwners.length).toBeGreaterThan(0);
    // D.54 reveal-on-demand: even view_owner_pii does NOT unmask the bulk export;
    // cleartext is only via POST /owners/:id/reveal-pii. No cleartext NID leaks.
    expect(allOwners.every((o) => o.nationalId!.startsWith('•'))).toBe(true);
    expect(allOwners.some((o) => o.nationalId === '300000010')).toBe(false);
  });

  it('2e) agent WITHOUT view_owners → export carries ZERO owner rows (D.54/D.50 read-scope)', async () => {
    const [u] = await db
      .insert(users)
      .values({
        email: `agent-noview-${Date.now()}-${Math.random()}@test.local`,
        name: 'NoView Agent',
        passwordHash: '$2b$12$placeholder',
      })
      .returning({ id: users.id });
    await db.insert(memberships).values({
      userId: u!.id,
      orgId: orgA.id,
      role: 'agent',
      isPrimary: false,
      acceptedAt: new Date(),
      capabilities: {
        edit_project_data: false,
        manage_documents: false,
        run_imports: false,
        manage_signatures: false,
        manage_tasks: false,
        view_owners: false, // cannot see owners on screen → none in export
        view_owner_pii: false,
      },
    });
    await withTenant(orgA.id, async (tx) => {
      await tx.insert(projectAssignments).values({
        projectId: orgA.projects[0]!.id,
        userId: u!.id,
        roleInProject: 'agent',
        assignedBy: orgA.users[0]!.id,
      });
    });
    const agentPayload: AccessTokenPayload = {
      sub: u!.id,
      orgId: orgA.id,
      role: 'agent',
      sid: '00000000-0000-0000-0000-000000000000',
      type: 'access',
      iat: 0,
      exp: 0,
    } as unknown as AccessTokenPayload;
    const { input } = await svc.composeProjectExport(agentPayload, orgA.projects[0]!.id, 'xlsx');
    // Project + buildings + apartments still visible (assigned), but every
    // apartment's owners array is empty — mirrors the on-screen owner deny.
    expect(input.buildings.length).toBeGreaterThan(0);
    const allOwners = input.buildings.flatMap((b) => b.apartments.flatMap((a) => a.owners));
    expect(allOwners.length).toBe(0);
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

  it('5) auditLog — writes one `project.export.requested` row per call with action + targetId + afterState.format (Wave 5 E-C1)', async () => {
    // Wave 5 E-C1 (errors audit 2026-05-28): the composer now writes
    // a pre-flight `project.export.requested` row (committed in the
    // composer tx). The controller writes a paired
    // `project.export.delivered` (or `.failed`) AFTER the renderer —
    // covered by the post-render outcome assertion below.
    const before = await withTenant(orgA.id, (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'project.export.requested'),
            eq(auditLog.targetId, orgA.projects[0]!.id),
          ),
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
          and(
            eq(auditLog.action, 'project.export.requested'),
            eq(auditLog.targetId, orgA.projects[0]!.id),
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(beforeCount + 1),
    );
    expect(after.length).toBeGreaterThan(beforeCount);
    const newest = after[0]!;
    expect(newest.action).toBe('project.export.requested');
    expect(newest.targetId).toBe(orgA.projects[0]!.id);
    expect((newest.afterState as { format?: string }).format).toBe('pdf');
  });

  it('6) Wave 5 E-C1 — auditExportOutcome writes a `project.export.delivered` row in a fresh tx', async () => {
    await svc.auditExportOutcome(userOf(orgA), orgA.projects[0]!.id, 'xlsx', 'delivered', {
      bytes: 12345,
    });
    const [row] = await withTenant(orgA.id, (tx) =>
      tx
        .select({ action: auditLog.action, afterState: auditLog.afterState })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'project.export.delivered'),
            eq(auditLog.targetId, orgA.projects[0]!.id),
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(1),
    );
    expect(row).toBeDefined();
    expect(row!.action).toBe('project.export.delivered');
    expect((row!.afterState as { bytes?: number }).bytes).toBe(12345);
  });

  it('7) Wave 5 E-C1 — auditExportOutcome writes a `project.export.failed` row with the error tag', async () => {
    await svc.auditExportOutcome(userOf(orgA), orgA.projects[0]!.id, 'pdf', 'failed', {
      errorTag: 'TimeoutError',
    });
    const [row] = await withTenant(orgA.id, (tx) =>
      tx
        .select({ action: auditLog.action, afterState: auditLog.afterState })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'project.export.failed'),
            eq(auditLog.targetId, orgA.projects[0]!.id),
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(1),
    );
    expect(row).toBeDefined();
    expect(row!.action).toBe('project.export.failed');
    expect((row!.afterState as { error?: string }).error).toBe('TimeoutError');
  });

  // ── B6 (DOCUMENT-SECURITY-AUDIT) — full-PII export requires step-up ──────
  describe('B6 — full-PII export step-up gate', () => {
    it('B6.1) default (masked) export needs NO step-up — masked cleartext, pii_included=false', async () => {
      // No session unlock at all — the masked path must still serve.
      const { input, piiIncluded } = await svc.composeProjectExport(
        userOf(orgA),
        orgA.projects[0]!.id,
        'xlsx',
        // piiMode defaults to 'masked'
      );
      expect(piiIncluded).toBe(false);
      const allOwners = input.buildings.flatMap((b) => b.apartments.flatMap((a) => a.owners));
      expect(allOwners.length).toBeGreaterThan(0);
      // Every national_id is masked — no cleartext leaks on the default path.
      expect(allOwners.every((o) => o.nationalId!.startsWith('•'))).toBe(true);
      expect(allOwners.some((o) => o.nationalId === '300000010')).toBe(false);
    });

    it('B6.2) full export WITHOUT a valid unlock → 403 pii_step_up_required (no cleartext served)', async () => {
      const locked = await makeSessionUser(orgA, { unlocked: false });
      await expect(
        svc.composeProjectExport(locked, orgA.projects[0]!.id, 'xlsx', 'full'),
      ).rejects.toMatchObject({
        status: 403,
        response: { error: { code: 'pii_step_up_required' } },
      });
    });

    it('B6.2b) full export with an EXPIRED unlock (older than the TTL) → 403 pii_step_up_required', async () => {
      // piiUnlockTtlMinutes default = 60; stamp it 61 minutes ago → expired.
      const stale = await makeSessionUser(orgA, {
        unlocked: true,
        unlockedAt: new Date(Date.now() - 61 * 60 * 1000),
      });
      await expect(
        svc.composeProjectExport(stale, orgA.projects[0]!.id, 'xlsx', 'full'),
      ).rejects.toMatchObject({
        status: 403,
        response: { error: { code: 'pii_step_up_required' } },
      });
    });

    it('B6.2c) [B5-class] full export with a FRESH unlock but reveal_pii REVOKED (export.run kept) → 403 pii_step_up_required + ZERO cleartext', async () => {
      // The B5-class regression this fix closes. Reproduce the defect state on a
      // DEDICATED org (so the DENY override never bleeds into orgA's other B6
      // assertions): seed one owner with a known cleartext national_id/phone,
      // give the user a FRESH (non-expired) step-up unlock so the freshness/TTL
      // half ALONE would pass, then REVOKE owners.reveal_pii while keeping
      // export.run. Before this fix, the export served cleartext for the full
      // TTL while the document path correctly 403'd. After: the live reveal_pii
      // re-assertion (mirrors documents.service.ts) throws the SAME shared 403.
      const ts = Date.now();
      const orgRevoked = await createTestOrg(`B6C-${ts}`, `b6c-${ts}`);
      const ownerId = await makeOwner(orgRevoked, {
        name: 'נעמי רבוק',
        nationalId: '399999091',
        phone: '0509990091',
      });
      const bld = await makeBuilding(orgRevoked, 0, 'בלד רבוק');
      const apt = await makeApartment(orgRevoked, bld, { number: 'R-1' });
      await makeOwnershipBundle(orgRevoked, apt, [{ ownerId, pct: '100' }]);

      // FRESH unlock — the access/TTL half passes; only the entitlement half can block.
      const freshButRevoked = await makeSessionUser(orgRevoked, { unlocked: true });
      // Strip reveal_pii (keep export.run) — the live engine now resolves
      // export+read but NOT reveal-PII for this caller.
      await revokeRevealPii(orgRevoked);

      // (a) The full export is REJECTED with the shared step-up 403 …
      await expect(
        svc.composeProjectExport(freshButRevoked, orgRevoked.projects[0]!.id, 'xlsx', 'full'),
      ).rejects.toMatchObject({
        status: 403,
        response: { error: { code: 'pii_step_up_required' } },
      });

      // … and (a) cont. — ZERO cleartext: the throw happens BEFORE the decrypt,
      // so nothing is round-tripped into heap. Re-running the request and proving
      // it still throws (never resolves an input carrying the cleartext id/phone)
      // is the strongest in-test evidence we can assert against the same defect.
      await expect(
        svc.composeProjectExport(freshButRevoked, orgRevoked.projects[0]!.id, 'xlsx', 'full'),
      ).rejects.toMatchObject({ status: 403 });

      // Doc-path PARITY control — the MASKED export on the SAME revoked actor
      // still serves (reveal_pii is NOT needed for masked, exactly as the
      // documents path lets a masked-role surface through the shared access gate
      // and masks per-field). And the national_id is masked, never cleartext.
      const { input: maskedInput, piiIncluded } = await svc.composeProjectExport(
        freshButRevoked,
        orgRevoked.projects[0]!.id,
        'xlsx',
        'masked',
      );
      expect(piiIncluded).toBe(false);
      const maskedOwners = maskedInput.buildings.flatMap((b) =>
        b.apartments.flatMap((a) => a.owners),
      );
      expect(maskedOwners.length).toBeGreaterThan(0);
      expect(maskedOwners.every((o) => o.nationalId!.startsWith('•'))).toBe(true);
      expect(maskedOwners.some((o) => o.nationalId === '399999091')).toBe(false);
    });

    it('B6.3) full export WITH a valid unlock → 200, CLEARTEXT national_id/phone, pii_included=true', async () => {
      const unlocked = await makeSessionUser(orgA, { unlocked: true });
      const { input, piiIncluded } = await svc.composeProjectExport(
        unlocked,
        orgA.projects[0]!.id,
        'xlsx',
        'full',
      );
      expect(piiIncluded).toBe(true);
      const allOwners = input.buildings.flatMap((b) => b.apartments.flatMap((a) => a.owners));
      const david = allOwners.find((o) => o.name === 'דוד כהן')!;
      // Full fidelity: the REAL national_id + phone are emitted (the audited,
      // step-up-gated path — the one legitimate bulk-PII surface).
      expect(david.nationalId).toBe('300000010');
      expect(david.phone).toBe('0501110001');
    });

    it('B6.4) full export with a valid unlock writes an audit row with pii_included=true and NO PII', async () => {
      const unlocked = await makeSessionUser(orgA, { unlocked: true });
      await svc.composeProjectExport(unlocked, orgA.projects[0]!.id, 'xlsx', 'full');
      const [row] = await withTenant(orgA.id, (tx) =>
        tx
          .select({ afterState: auditLog.afterState })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'project.export.requested'),
              eq(auditLog.targetId, orgA.projects[0]!.id),
              eq(auditLog.sessionId, unlocked.sid),
            ),
          )
          .orderBy(desc(auditLog.createdAt))
          .limit(1),
      );
      expect(row).toBeDefined();
      const after = row!.afterState as { piiIncluded?: boolean; rowCount?: number };
      expect(after.piiIncluded).toBe(true);
      expect(after.rowCount).toBeGreaterThan(0);
      // PII-never-logged: the audit row's serialized JSON must NOT contain any
      // owner national_id or phone — counts + flags only.
      const json = JSON.stringify(row!.afterState);
      expect(json).not.toContain('300000010'); // David's national_id
      expect(json).not.toContain('0501110001'); // David's phone
    });

    it('B6.5) a valid unlock does NOT change the MASKED default — masked stays masked, pii_included=false', async () => {
      const unlocked = await makeSessionUser(orgA, { unlocked: true });
      const { input, piiIncluded } = await svc.composeProjectExport(
        unlocked,
        orgA.projects[0]!.id,
        'xlsx',
        'masked',
      );
      expect(piiIncluded).toBe(false);
      const allOwners = input.buildings.flatMap((b) => b.apartments.flatMap((a) => a.owners));
      expect(allOwners.every((o) => o.nationalId!.startsWith('•'))).toBe(true);
    });
  });
});
