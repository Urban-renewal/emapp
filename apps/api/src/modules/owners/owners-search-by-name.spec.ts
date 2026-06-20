/**
 * NS1 (server-side search, MASTER-PLAN-V13 Wave B) — owner NAME search.
 *
 * Asserts `OwnersService.searchByName` against the REAL local DB. The owner
 * name is PII stored ENCRYPTED at rest; the service decrypts it IN-SQL under
 * the withTenant key and ILIKEs the plaintext — so a real DB (pgcrypto +
 * app.encryption_key GUC) is mandatory; mocking would defeat the test.
 *
 * THE CONTRACT under test:
 *  - q match: returns owners whose decrypted NAME contains the substring
 *    (case-insensitive); a non-matching owner is absent.
 *  - masked projection: national_id/phone come back MASKED (•••), NEVER
 *    cleartext — the D.47 tripwire holds on the search surface.
 *  - RLS isolation: org-A never finds org-B's owner by name.
 *  - keyset cursor: limit=1 over ≥2 matches → has_more + cursor; page2 no dup.
 *  - agent scope: an agent sees ONLY owners in their assigned-project apartments
 *    (an owner in an unassigned project is invisible even on a name match).
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/owners/owners-search-by-name.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  db,
  encryptOwnerPii,
  memberships,
  owners,
  ownerships,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnersService } from './owners.service';

let svc: OwnersService;
let orgA: TestOrg;
let orgB: TestOrg;
let mgrAId: string;
let mgrBId: string;
let agentAId: string;

const TAG = randomUUID().slice(0, 8);

function managerA(): AccessTokenPayload {
  return { sub: mgrAId, orgId: orgA.id, role: 'manager', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}
function managerB(): AccessTokenPayload {
  return { sub: mgrBId, orgId: orgB.id, role: 'manager', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}
function agentA(): AccessTokenPayload {
  return { sub: agentAId, orgId: orgA.id, role: 'agent', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}

function natId(): string {
  return String(Math.floor(100_000_000 + Math.random() * 899_999_999));
}

async function seedOwner(orgId: string, name: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name,
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: `o-${randomUUID()}@test.local`,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `ag-${randomUUID()}@test.local`, name: 'Ag', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db.insert(memberships).values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** Link an owner to a project via a NEW building+apartment+active ownership. */
async function linkOwnerToProject(orgId: string, projectId: string, ownerId: string): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [b] = await tx
      .insert(buildings)
      .values({ projectId, address: `addr ${randomUUID()}`, city: 'TLV' })
      .returning({ id: buildings.id });
    const [a] = await tx
      .insert(apartments)
      .values({ buildingId: b!.id, number: `N-${randomUUID().slice(0, 8)}` })
      .returning({ id: apartments.id });
    await tx.insert(ownerships).values({
      apartmentId: a!.id,
      ownerId,
      relationship: 'owner',
      ownershipPct: '100',
      shareNumerator: 10_000,
      shareDenominator: 10_000,
    });
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new OwnersService();
  orgA = await createTestOrg(`OwnSrchA-${TAG}`);
  orgB = await createTestOrg(`OwnSrchB-${TAG}`);
  mgrAId = orgA.users[0]!.id;
  mgrBId = orgB.users[0]!.id;
  agentAId = await seedAgent(orgA.id);
}, 60_000);

afterAll(async () => {
  /* harmless leftover rows; other suites filter by their own tags */
});

describe('NS1 owners search-by-name', () => {
  it('q matches owners by decrypted name substring; non-match absent', async () => {
    const hit = `כהן ${TAG}`;
    const miss = `לוי ${TAG}`;
    const hitId = await seedOwner(orgA.id, hit);
    await seedOwner(orgA.id, miss);

    const res = await svc.searchByName(managerA(), { q: 'כהן', limit: 100 });
    const ids = res.data.map((o) => o.id);
    expect(ids).toContain(hitId);
    expect(res.data.find((o) => o.id === hitId)!.name).toBe(hit);
    expect(res.data.map((o) => o.name)).not.toContain(miss);
  });

  it('national_id/phone are MASKED (never cleartext) on the search result', async () => {
    const name = `Masked ${TAG}-${randomUUID().slice(0, 6)}`;
    const id = await seedOwner(orgA.id, name);
    const res = await svc.searchByName(managerA(), { q: name, limit: 10 });
    const owner = res.data.find((o) => o.id === id)!;
    expect(owner).toBeDefined();
    // masked suffix shape, NOT a 9-digit cleartext id / raw phone
    expect(owner.nationalIdMasked).toMatch(/^•+\d{2}$/);
    expect(owner.phoneMasked).toMatch(/^•+\d{4}$/);
    expect(owner).not.toHaveProperty('national_id');
    expect(owner).not.toHaveProperty('phone');
    // the masked value must not be a full 9-digit number
    expect(String(owner.nationalIdMasked)).not.toMatch(/^\d{9}$/);
  });

  it('RLS isolation: org-A manager never finds org-B owner by name', async () => {
    const bName = `OrgBOwner ${TAG}`;
    const bId = await seedOwner(orgB.id, bName);
    const fromA = await svc.searchByName(managerA(), { q: 'orgbowner', limit: 100 });
    expect(fromA.data.map((o) => o.id)).not.toContain(bId);
    const fromB = await svc.searchByName(managerB(), { q: 'orgbowner', limit: 100 });
    expect(fromB.data.map((o) => o.id)).toContain(bId);
  });

  it('keyset cursor over ≥2 matches: page1(limit=1) has_more+cursor, page2 no dup', async () => {
    const ks = `Keyset${TAG}${randomUUID().slice(0, 6)}`;
    await seedOwner(orgA.id, `${ks} One`);
    await seedOwner(orgA.id, `${ks} Two`);
    const page1 = await svc.searchByName(managerA(), { q: ks, limit: 1 });
    expect(page1.data).toHaveLength(1);
    expect(page1.page.has_more).toBe(true);
    expect(page1.page.cursor).toBeTruthy();
    const page2 = await svc.searchByName(managerA(), { q: ks, limit: 1, cursor: page1.page.cursor! });
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id);
  });

  it('agent scope: sees only owners in assigned-project apartments', async () => {
    const assignedName = `AgentHit ${TAG}-${randomUUID().slice(0, 6)}`;
    const unassignedName = `AgentMiss ${TAG}-${randomUUID().slice(0, 6)}`;
    const assignedOwner = await seedOwner(orgA.id, assignedName);
    const unassignedOwner = await seedOwner(orgA.id, unassignedName);

    const assignedProj = orgA.projects[0]!.id;
    const unassignedProj = orgA.projects[1]!.id;
    await linkOwnerToProject(orgA.id, assignedProj, assignedOwner);
    await linkOwnerToProject(orgA.id, unassignedProj, unassignedOwner);
    await db
      .insert(projectAssignments)
      .values({ projectId: assignedProj, userId: agentAId, assignedBy: mgrAId });

    const res = await svc.searchByName(agentA(), { q: TAG, limit: 100 });
    const ids = res.data.map((o) => o.id);
    expect(ids).toContain(assignedOwner);
    expect(ids).not.toContain(unassignedOwner);
  });
});
