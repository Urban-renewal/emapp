/**
 * S3d — owner↔project surfacing + co-ownership (design §2; read-only, NO migration).
 *
 * INDEPENDENT acceptance tests, written from the SPEC before the builder. These
 * assert the TARGET behavior; they are RED against current code and GREEN after
 * the builder lands it. Two gaps under test:
 *
 *   (a) NEW: the DISTINCT projects an owner is tied to, derived via ACTIVE
 *       ownerships: owner → ownerships (ended_at IS NULL) → apartments →
 *       buildings → projects. DISTINCT (same project twice → once). org-scoped
 *       (withTenant — an owner in org A never surfaces org B's projects).
 *       Surfaced as `OwnersService.listProjects(user, ownerId)` returning the
 *       `{ data: [...] }` list (the controller wraps it for
 *       GET /api/v1/owners/:id/projects). Today this method/endpoint does NOT
 *       exist → RED (method missing / 404).
 *
 *   (b) `ApartmentOwnerSchema` (the co-owner projection from
 *       GET /apartments/:id/owners → listApartmentOwners) must ALSO carry the
 *       EXACT Tabu fraction `shareNumerator` + `shareDenominator` (today it
 *       surfaces only `ownershipPct`). A co-owner at 1/3 shows num=1/den=3, not
 *       just pct 33.33. Today the projection + schema OMIT these → RED.
 *
 * Real DB (Neon) — the joins + RLS org-scope are the whole point; mocking would
 * defeat it. Seeding + auth style mirror owner-renter.spec.ts /
 * owners-capability.spec.ts.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/owners/owner-project-surfacing.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { ApartmentOwnerSchema } from '@emapp/shared-types';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { OwnershipsService } from '../ownerships/ownerships.service';

import { OwnersService } from './owners.service';

let ownersSvc: OwnersService;
let ownershipsSvc: OwnershipsService;
let org: TestOrg;
let other: TestOrg;
let managerId: string;
let agentId: string;

const MGR_SID = '00000000-0000-4000-8000-00000000d001';
const AGENT_SID = '00000000-0000-4000-8000-00000000d0a1';

function manager(orgId = org.id): AccessTokenPayload {
  return {
    sub: managerId,
    orgId,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function agent(orgId = org.id): AccessTokenPayload {
  return {
    sub: agentId,
    orgId,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

// ---- agent / capability seeding (mirror owners-capability.spec.ts) ----------

/** Seed an AGENT user + an active org membership. The default membership
 *  capabilities already carry `view_owners: true` (tenancy.ts default), so the
 *  fresh agent can read owners unless we explicitly toggle it off below. */
async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `agent-${randomUUID()}@test.local`, name: 'Agent', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** Flip the agent's `view_owners` capability (jsonb_set, same as
 *  owners-capability.spec.ts's setCapability). Used to prove the 403 gate. */
async function setViewOwners(on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{view_owners}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

/** Assign the agent to a project (active = unassigned_at NULL). */
async function assignAgentToProject(projectId: string): Promise<void> {
  await db.insert(projectAssignments).values({ projectId, userId: agentId, assignedBy: managerId });
}

/** Soft-unassign the agent from a project (sets unassigned_at — the tie is now
 *  HISTORICAL, so the EXISTS over unassigned_at IS NULL no longer matches). */
async function unassignAgentFromProject(projectId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE project_assignments SET unassigned_at = now()
       WHERE project_id = $1 AND user_id = $2 AND unassigned_at IS NULL`,
      [projectId, agentId],
    );
  } finally {
    c.release();
  }
}

// ---- seeding helpers (mirror owner-renter.spec.ts) -------------------------

/** Unique 9-digit national_id (the constraint is uniqueness, not check-digit). */
function natId(): string {
  return String(Math.floor(100_000_000 + Math.random() * 899_999_999));
}

async function seedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: `owner-${randomUUID()}@test.local`,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Fresh apartment under a NEW building in the given project (so each apartment
 *  is isolated for the per-apartment ownership-sum trigger + the unique-active
 *  (apartment,owner) index). Returns the apartment id. */
async function seedApartment(orgId: string, projectId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [bld] = await tx
      .insert(buildings)
      .values({
        projectId,
        address: `S3d ${Date.now()}-${Math.random()}`,
        city: 'Tel Aviv',
      })
      .returning({ id: buildings.id });
    const [apt] = await tx
      .insert(apartments)
      .values({ buildingId: bld!.id, number: `A-${Date.now()}-${Math.random()}` })
      .returning({ id: apartments.id });
    return apt!.id;
  });
}

/** Insert OWNER ownership rows DIRECTLY via the provider pool (BYPASSRLS) so the
 *  full set for one apartment lands in ONE tx (the DEFERRED sum trigger validates
 *  the committed set). Pct → fraction num=round(pct*100), den=10000 (the same
 *  derivation every real write path uses). */
async function insertOwnerSet(
  apartmentId: string,
  rows: Array<{ ownerId: string; pct: number }>,
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    for (const r of rows) {
      const num = Math.round(r.pct * 100);
      await c.query(
        `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
         VALUES ($1, $2, $3, 'owner', $4, 10000)`,
        [apartmentId, r.ownerId, String(r.pct), num],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Insert ONE owner ownership row carrying an EXACT fraction (num/den) directly,
 *  so a 1/3 co-owner is stored as 1/3 (not 3333/10000). All rows for one
 *  apartment in ONE tx. ownership_pct is the derived compat percent. */
async function insertFractionalOwnerSet(
  apartmentId: string,
  rows: Array<{ ownerId: string; num: number; den: number }>,
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    for (const r of rows) {
      const pct = Math.round((r.num / r.den) * 100 * 100) / 100;
      await c.query(
        `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
         VALUES ($1, $2, $3, 'owner', $4, $5)`,
        [apartmentId, r.ownerId, String(pct), r.num, r.den],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Call the target owner→projects surface. The builder will add
 *  `OwnersService.listProjects(user, ownerId)` returning `{ data: Project[] }`
 *  (the controller wraps it for GET /api/v1/owners/:id/projects). Until then this
 *  cast lets the spec compile while the method is absent at runtime → RED. */
async function listOwnerProjects(
  user: AccessTokenPayload,
  ownerId: string,
): Promise<{ data: Array<{ id: string }> }> {
  const svc = ownersSvc as unknown as {
    listProjects?: (u: AccessTokenPayload, id: string) => Promise<{ data: Array<{ id: string }> }>;
  };
  if (typeof svc.listProjects !== 'function') {
    throw new Error('OwnersService.listProjects is not implemented (endpoint missing)');
  }
  return svc.listProjects(user, ownerId);
}

beforeAll(async () => {
  await setupTestDatabase();
  ownersSvc = new OwnersService();
  ownershipsSvc = new OwnershipsService();
  const tag = `s3d-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  other = await createTestOrg(`${tag}-x`, `${tag}-x`);
  managerId = org.users[0]!.id;
  agentId = await seedAgent(org.id);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ===========================================================================
// (a) GET /owners/:id/projects — DISTINCT projects via active ownerships
// ===========================================================================
describe('(a) owner → projects surfacing', () => {
  it('1) returns the projects an owner is tied to (ownership → apartment → building → project)', async () => {
    const projectP = org.projects[0]!.id;
    const owner = await seedOwner(org.id);
    const apt = await seedApartment(org.id, projectP);
    await insertOwnerSet(apt, [{ ownerId: owner, pct: 100 }]);

    const res = await listOwnerProjects(manager(), owner);
    expect(res.data.map((p) => p.id)).toContain(projectP);
  }, 30_000);

  it('2a) DISTINCT — 2 apartments in the SAME project → that project appears exactly ONCE', async () => {
    const projectP = org.projects[0]!.id;
    const owner = await seedOwner(org.id);
    // two SEPARATE apartments (separate buildings) under the SAME project
    const apt1 = await seedApartment(org.id, projectP);
    const apt2 = await seedApartment(org.id, projectP);
    await insertOwnerSet(apt1, [{ ownerId: owner, pct: 100 }]);
    await insertOwnerSet(apt2, [{ ownerId: owner, pct: 100 }]);

    const res = await listOwnerProjects(manager(), owner);
    const occurrences = res.data.filter((p) => p.id === projectP).length;
    expect(occurrences).toBe(1);
  }, 30_000);

  it('2b) apartments in TWO DIFFERENT projects → BOTH projects appear', async () => {
    const projectA = org.projects[0]!.id;
    const projectB = org.projects[1]!.id;
    const owner = await seedOwner(org.id);
    const aptA = await seedApartment(org.id, projectA);
    const aptB = await seedApartment(org.id, projectB);
    await insertOwnerSet(aptA, [{ ownerId: owner, pct: 100 }]);
    await insertOwnerSet(aptB, [{ ownerId: owner, pct: 100 }]);

    const res = await listOwnerProjects(manager(), owner);
    const ids = res.data.map((p) => p.id);
    expect(ids).toContain(projectA);
    expect(ids).toContain(projectB);
  }, 30_000);

  it('3a) org-scoped — never surfaces another org’s project (cross-org isolation)', async () => {
    // An owner in `other` org tied to one of `other`'s projects.
    const otherProject = other.projects[0]!.id;
    const otherOwner = await seedOwner(other.id);
    const otherApt = await seedApartment(other.id, otherProject);
    await insertOwnerSet(otherApt, [{ ownerId: otherOwner, pct: 100 }]);

    // Queried from `org`'s manager: the cross-org owner is invisible (RLS) and
    // its project must NEVER appear. Either the owner is not-found (404) or the
    // list is empty — either way, `other`'s project is absent.
    const otherProjectVisible = await listOwnerProjects(manager(), otherOwner)
      .then((r) => r.data.some((p) => p.id === otherProject))
      .catch(() => false); // 404 / not-found is an acceptable no-oracle outcome
    expect(otherProjectVisible).toBe(false);
  }, 30_000);

  it('3b) an owner with NO active ownerships → empty project list', async () => {
    const bareOwner = await seedOwner(org.id);
    const res = await listOwnerProjects(manager(), bareOwner);
    expect(res.data).toEqual([]);
  }, 30_000);
});

// ===========================================================================
// (a2) AGENT project-scope — the load-bearing EXISTS over project_assignments.
// These are regression guards: a refactor that drops the agentScope EXISTS (or
// the assertAgentCanViewOwners / assertOwnerInAssignedProject gates) silently
// re-opens a cross-project leak. Each test pins one limb of that surface.
// Capability + project_assignment seeding mirrors owners-capability.spec.ts.
// ===========================================================================
describe('(a2) agent project-scope on listProjects', () => {
  it('6) agent sees ONLY assigned projects of a multi-project owner (EXISTS clause is load-bearing)', async () => {
    // Owner sits in BOTH project A and project B; the agent is assigned to A only.
    const projectA = org.projects[0]!.id;
    const projectB = org.projects[1]!.id;
    const owner = await seedOwner(org.id);
    const aptA = await seedApartment(org.id, projectA);
    const aptB = await seedApartment(org.id, projectB);
    await insertOwnerSet(aptA, [{ ownerId: owner, pct: 100 }]);
    await insertOwnerSet(aptB, [{ ownerId: owner, pct: 100 }]);

    await assignAgentToProject(projectA); // assigned to A, NOT B
    try {
      const res = await ownersSvc.listProjects(agent(), owner);
      const ids = res.data.map((p) => p.id);
      // The agentScope EXISTS surfaces A and HIDES B. Dropping it would make B
      // appear → this assertion goes RED, which is the whole point of the guard.
      expect(ids).toContain(projectA);
      expect(ids).not.toContain(projectB);
    } finally {
      await unassignAgentFromProject(projectA);
    }
  }, 30_000);

  it('7) agent WITHOUT view_owners capability → 403 (assertAgentCanViewOwners)', async () => {
    // Owner in an assigned project, but the agent lacks view_owners → the
    // outermost gate denies before any project ever surfaces.
    const projectA = org.projects[0]!.id;
    const owner = await seedOwner(org.id);
    const apt = await seedApartment(org.id, projectA);
    await insertOwnerSet(apt, [{ ownerId: owner, pct: 100 }]);
    await assignAgentToProject(projectA);
    await setViewOwners(false);
    try {
      await expect(ownersSvc.listProjects(agent(), owner)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    } finally {
      await setViewOwners(true);
      await unassignAgentFromProject(projectA);
    }
  }, 30_000);

  it('8) agent whose ONLY tie to the owner is an UNASSIGNED project → 404 (assertOwnerInAssignedProject, no oracle)', async () => {
    // Owner lives only in project A; the agent was assigned to A then UNASSIGNED
    // (unassigned_at set). The historical tie must NOT grant access — the owner
    // collapses to a clean 404, indistinguishable from absent (no oracle).
    const projectA = org.projects[0]!.id;
    const owner = await seedOwner(org.id);
    const apt = await seedApartment(org.id, projectA);
    await insertOwnerSet(apt, [{ ownerId: owner, pct: 100 }]);
    await assignAgentToProject(projectA);
    await unassignAgentFromProject(projectA); // tie is now historical
    await expect(ownersSvc.listProjects(agent(), owner)).rejects.toBeInstanceOf(NotFoundException);
  }, 30_000);

  it('9) manager baseline — sees BOTH projects of the multi-project owner (no agent scoping)', async () => {
    // Contrast for #6: with no agentScope applied, a manager sees A AND B. This
    // proves #6's exclusion of B is the AGENT scope, not a seeding artifact.
    const projectA = org.projects[0]!.id;
    const projectB = org.projects[1]!.id;
    const owner = await seedOwner(org.id);
    const aptA = await seedApartment(org.id, projectA);
    const aptB = await seedApartment(org.id, projectB);
    await insertOwnerSet(aptA, [{ ownerId: owner, pct: 100 }]);
    await insertOwnerSet(aptB, [{ ownerId: owner, pct: 100 }]);

    const res = await ownersSvc.listProjects(manager(), owner);
    const ids = res.data.map((p) => p.id);
    expect(ids).toContain(projectA);
    expect(ids).toContain(projectB);
  }, 30_000);
});

// ===========================================================================
// (b) ApartmentOwner co-owner projection carries the EXACT fraction
// ===========================================================================
describe('(b) co-owner projection carries shareNumerator/shareDenominator', () => {
  it('4) ApartmentOwnerSchema declares shareNumerator + shareDenominator', () => {
    // The schema (shared-types SoT) must accept the fraction fields. A row at 1/3
    // must round-trip num=1/den=3 through .parse() — proving the fields are part
    // of the contract, not stripped. RED now: the schema omits them, so the
    // parsed object loses the fields.
    const sample = {
      id: randomUUID(),
      organizationId: randomUUID(),
      name: 'בעלים',
      email: null,
      nationalIdMasked: '•••••••82',
      phoneMasked: '•••••1234',
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null,
      ownershipId: randomUUID(),
      ownershipPct: 33.33,
      relationship: 'owner' as const,
      role: null,
      shareNumerator: 1,
      shareDenominator: 3,
    };
    const parsed = ApartmentOwnerSchema.parse(sample);
    expect(parsed).toMatchObject({ shareNumerator: 1, shareDenominator: 3 });
  });

  it('5) listApartmentOwners returns BOTH co-owners with their EXACT fractions (1/3 + 2/3)', async () => {
    const projectP = org.projects[0]!.id;
    const apt = await seedApartment(org.id, projectP);
    const coOwnerA = await seedOwner(org.id); // 1/3
    const coOwnerB = await seedOwner(org.id); // 2/3
    await insertFractionalOwnerSet(apt, [
      { ownerId: coOwnerA, num: 1, den: 3 },
      { ownerId: coOwnerB, num: 2, den: 3 },
    ]);

    const page = await ownershipsSvc.listApartmentOwners(manager(), apt, { limit: 50 });
    expect(page.data).toHaveLength(2);

    const byId = new Map(
      page.data.map((r) => [
        r.id,
        r as typeof r & { shareNumerator?: number; shareDenominator?: number },
      ]),
    );
    const a = byId.get(coOwnerA)!;
    const b = byId.get(coOwnerB)!;

    // RED now: the projection omits shareNumerator/shareDenominator → undefined.
    expect(a.shareNumerator).toBe(1);
    expect(a.shareDenominator).toBe(3);
    expect(b.shareNumerator).toBe(2);
    expect(b.shareDenominator).toBe(3);

    // The exact fractions sum to the whole (1/3 + 2/3 = 1) — independent of the
    // lossy compat percent (33.33 + 66.67).
    const sum = a.shareNumerator! / a.shareDenominator! + b.shareNumerator! / b.shareDenominator!;
    expect(sum).toBeCloseTo(1, 10);
  }, 30_000);
});
