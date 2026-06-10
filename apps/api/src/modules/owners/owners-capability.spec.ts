/**
 * D.46 — owner EDIT project-scoping for agents (own careful slice).
 *
 * An agent with edit_project_data may edit (update/archive) an owner ONLY if
 * that owner holds an ownership in an apartment whose building's project the
 * agent is actively assigned to. Otherwise → 404 (no oracle). create stays
 * manager-only (a bare new owner has no project to scope).
 *
 * Mechanism evidence (D.51 + owner's required cases):
 *   - owner in an ASSIGNED project → agent edit allowed.
 *   - owner only in an UNASSIGNED project → 404 (project-scope gate).
 *   - bare owner (no ownership) → 404.
 *   - cross-tenant owner → 404 (RLS; no oracle).
 *   - agent WITHOUT the capability on an assigned-project owner → 403.
 *   - manager edits any owner (no scoping).
 *   - PII never leaks (the success response is masked; errors carry no PII).
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnersService } from './owners.service';

let svc: OwnersService;
let org: TestOrg;
let other: TestOrg;
let managerId: string;
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;

// the three owner fixtures (in org)
let ownerAssigned: string; // ownership in an apartment in the ASSIGNED project
let ownerUnassigned: string; // ownership in an apartment in the UNASSIGNED project
let ownerBare: string; // no ownership at all
let ownerCrossTenant: string; // belongs to `other` org

const NID_ASSIGNED = '111111118';
const AGENT_SID = '00000000-0000-4000-8000-0000000000a1';
const MGR_SID = '00000000-0000-4000-8000-0000000000a2';

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agent(): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: org.id,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

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

async function setCapability(on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{edit_project_data}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

async function seedBuilding(projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, 'TLV') RETURNING id`,
      [projectId, `St-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedApartment(buildingId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [buildingId, randomUUID().slice(0, 8)],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Soft-end every active ownership for an owner (D.25 set-replace shape). */
async function endOwnerships(ownerId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE ownerships SET ended_at = now() WHERE owner_id = $1 AND ended_at IS NULL`,
      [ownerId],
    );
  } finally {
    c.release();
  }
}

async function seedOwner(orgId: string, nationalId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId,
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function seedOwnership(apartmentId: string, ownerId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct) VALUES ($1, $2, 100.00)`,
      [apartmentId, ownerId],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new OwnersService();
  const tag = `d46-own-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  other = await createTestOrg(`${tag}-x`, `${tag}-x`);
  managerId = org.users[0]!.id;
  assignedProjectId = org.projects[0]!.id;
  unassignedProjectId = org.projects[1]!.id;
  agentId = await seedAgent(org.id);
  await db
    .insert(projectAssignments)
    .values({ projectId: assignedProjectId, userId: agentId, assignedBy: managerId });
  await setCapability(true);

  // owner in the ASSIGNED project
  const aptA = await seedApartment(await seedBuilding(assignedProjectId));
  ownerAssigned = await seedOwner(org.id, NID_ASSIGNED);
  await seedOwnership(aptA, ownerAssigned);

  // owner only in the UNASSIGNED project
  const aptU = await seedApartment(await seedBuilding(unassignedProjectId));
  ownerUnassigned = await seedOwner(org.id, '222222226');
  await seedOwnership(aptU, ownerUnassigned);

  // bare owner (no ownership)
  ownerBare = await seedOwner(org.id, '333333334');

  // cross-tenant owner
  ownerCrossTenant = await seedOwner(other.id, '444444442');
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('D.46 — owner edit project-scoping (agents)', () => {
  it('D46-OWN-1) agent edits an owner in an ASSIGNED project → allowed, PII masked', async () => {
    const res = await svc.update(agent(), ownerAssigned, { notes: 'edited by agent' });
    expect(res.id).toBe(ownerAssigned);
    // PII never leaks: the cleartext national_id is not in the response.
    expect(JSON.stringify(res)).not.toContain(NID_ASSIGNED);
    expect(res.nationalIdMasked!.startsWith('•')).toBe(true);
  });

  it('D46-OWN-2) agent edits an owner ONLY in an UNASSIGNED project → 404', async () => {
    await expect(svc.update(agent(), ownerUnassigned, { notes: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('D46-OWN-3) agent edits a BARE owner (no ownership) → 404', async () => {
    await expect(svc.update(agent(), ownerBare, { notes: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('D46-OWN-4) agent archives an owner in an assigned project → allowed', async () => {
    await expect(svc.archive(agent(), ownerAssigned)).resolves.toBeUndefined();
  });

  it('D46-OWN-5) cross-tenant owner → 404 (no oracle)', async () => {
    await expect(svc.update(agent(), ownerCrossTenant, { notes: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('D46-OWN-6) agent WITHOUT edit_project_data on an assigned-project owner → 403', async () => {
    // Re-seed a fresh assigned owner (ownerAssigned was archived in OWN-4).
    const apt = await seedApartment(await seedBuilding(assignedProjectId));
    const o = await seedOwner(org.id, '555555550');
    await seedOwnership(apt, o);
    await setCapability(false);
    try {
      await expect(svc.update(agent(), o, { notes: 'x' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    } finally {
      await setCapability(true);
    }
  }, 30_000);

  it('D46-OWN-8) owner whose ONLY assigned-project ownership is ENDED → 404 (active-only scope)', async () => {
    // Soft-ended ownerships (D.25 set-replace) must NOT grant edit — a
    // historical link to an assigned project is not current access.
    const apt = await seedApartment(await seedBuilding(assignedProjectId));
    const o = await seedOwner(org.id, '666666668');
    await seedOwnership(apt, o);
    await endOwnerships(o); // the only link to the assigned project is now ended
    await expect(svc.update(agent(), o, { notes: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  }, 30_000);

  it('D46-OWN-7) manager edits ANY owner (unassigned + bare) — no project scoping', async () => {
    const r1 = await svc.update(manager(), ownerUnassigned, { notes: 'mgr' });
    expect(r1.id).toBe(ownerUnassigned);
    const r2 = await svc.update(manager(), ownerBare, { notes: 'mgr' });
    expect(r2.id).toBe(ownerBare);
  }, 30_000); // two sequential real-DB updates — Neon latency under parallel load
});
