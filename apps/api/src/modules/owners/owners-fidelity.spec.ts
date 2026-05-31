/**
 * D.54 — view_owners gate + PII fidelity (view_owner_pii). Deterministic real-DB.
 *
 * - agent WITHOUT view_owners → full deny (403) on list/get/search.
 * - agent WITH view_owners → sees ONLY owners in assigned projects (scoped),
 *   PII MASKED by default (view_owner_pii off).
 * - agent WITH view_owners + view_owner_pii → cleartext national_id/phone in the
 *   DEDICATED `nationalId`/`phone` fields; `nationalIdMasked` STAYS masked (the
 *   §v9-M-4 tripwire is never overloaded with cleartext).
 * - manager → cleartext (dedicated fields); viewer → masked (no cleartext fields).
 *   Default masked. The cleartext value appears ONLY in the dedicated fields and
 *   ONLY when the actor's resolved fidelity is unmasked.
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
let managerId: string;
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;
let ownerAssigned: string;
let ownerUnassigned: string;

const NID_ASSIGNED = '111111118';
const PHONE_ASSIGNED = '0541239876';
const A_SID = '00000000-0000-4000-8000-0000000000b1';

function tok(
  role: 'manager' | 'agent' | 'viewer',
  sub = role === 'agent' ? agentId : managerId,
): AccessTokenPayload {
  return { sub, orgId: org.id, role, sid: A_SID, type: 'access' } as unknown as AccessTokenPayload;
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

async function setCaps(viewOwners: boolean, viewOwnerPii: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships
         SET capabilities = jsonb_set(
           jsonb_set(capabilities, '{view_owners}', $1::jsonb),
           '{view_owner_pii}', $2::jsonb)
       WHERE user_id = $3 AND org_id = $4 AND revoked_at IS NULL`,
      [viewOwners ? 'true' : 'false', viewOwnerPii ? 'true' : 'false', agentId, org.id],
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
async function seedOwner(orgId: string, nationalId: string, phone: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, { nationalId, name: 'בעלים', phone });
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
  const tag = `d54-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  assignedProjectId = org.projects[0]!.id;
  unassignedProjectId = org.projects[1]!.id;
  agentId = await seedAgent(org.id);
  await db
    .insert(projectAssignments)
    .values({ projectId: assignedProjectId, userId: agentId, assignedBy: managerId });

  const aptA = await seedApartment(await seedBuilding(assignedProjectId));
  ownerAssigned = await seedOwner(org.id, NID_ASSIGNED, PHONE_ASSIGNED);
  await seedOwnership(aptA, ownerAssigned);

  const aptU = await seedApartment(await seedBuilding(unassignedProjectId));
  ownerUnassigned = await seedOwner(org.id, '222222226', '0500000000');
  await seedOwnership(aptU, ownerUnassigned);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('D.54 — view_owners gate + PII fidelity', () => {
  it('DV-1) agent WITHOUT view_owners → 403 on list/get/search (full deny)', async () => {
    await setCaps(false, false);
    await expect(svc.list(tok('agent'), { limit: 10 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.get(tok('agent'), ownerAssigned)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.search(tok('agent'), { national_id: NID_ASSIGNED })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('DV-2) agent WITH view_owners → sees only ASSIGNED-project owners, MASKED', async () => {
    await setCaps(true, false);
    const page = await svc.list(tok('agent'), { limit: 50 });
    const ids = page.data.map((o) => o.id);
    expect(ids).toContain(ownerAssigned);
    expect(ids).not.toContain(ownerUnassigned); // out of agent scope
    const own = page.data.find((o) => o.id === ownerAssigned)!;
    expect(own.nationalIdMasked.startsWith('•')).toBe(true);
    expect(own.nationalId).toBeUndefined(); // masked actor: no cleartext field
    expect(JSON.stringify(page.data)).not.toContain(NID_ASSIGNED); // no cleartext anywhere
  }, 30_000);

  it('DV-3) agent WITH view_owners but NOT view_owner_pii → get → MASKED, no clear field', async () => {
    await setCaps(true, false);
    const o = await svc.get(tok('agent'), ownerAssigned);
    expect(o.nationalIdMasked).toBe('•••••••18');
    expect(o.phoneMasked).toBe('•••••9876');
    expect(o.nationalId).toBeUndefined();
    expect(o.phone).toBeUndefined();
  });

  it('DV-4) agent WITH view_owners + view_owner_pii → cleartext in DEDICATED fields, masked stays masked', async () => {
    await setCaps(true, true);
    const o = await svc.get(tok('agent'), ownerAssigned);
    expect(o.nationalIdMasked).toBe('•••••••18'); // tripwire field STAYS masked
    expect(o.phoneMasked).toBe('•••••9876');
    expect(o.nationalId).toBe(NID_ASSIGNED); // cleartext only in the dedicated field
    expect(o.phone).toBe(PHONE_ASSIGNED);
  });

  it('DV-5) agent WITH view_owners → get an owner in an UNASSIGNED project → 404 (scope)', async () => {
    await setCaps(true, true);
    await expect(svc.get(tok('agent'), ownerUnassigned)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('DV-6) manager → cleartext in dedicated field (their authorized view)', async () => {
    const o = await svc.get(tok('manager'), ownerAssigned);
    expect(o.nationalIdMasked).toBe('•••••••18'); // masked field stays masked
    expect(o.nationalId).toBe(NID_ASSIGNED);
    expect(o.phone).toBe(PHONE_ASSIGNED);
  });

  it('DV-7) viewer → masked, NO cleartext field (even with the owner visible)', async () => {
    const o = await svc.get(tok('viewer'), ownerAssigned);
    expect(o.nationalIdMasked).toBe('•••••••18');
    expect(o.nationalId).toBeUndefined();
    expect(o.phone).toBeUndefined();
  });

  it('DV-8) search honours scope + fidelity (agent masked, assigned-only)', async () => {
    await setCaps(true, false);
    const res = await svc.search(tok('agent'), { national_id: NID_ASSIGNED });
    expect(res.map((o) => o.id)).toContain(ownerAssigned);
    expect(res.every((o) => o.nationalIdMasked.startsWith('•'))).toBe(true);
    // searching the unassigned owner's NID → not visible to the agent
    const res2 = await svc.search(tok('agent'), { national_id: '222222226' });
    expect(res2.map((o) => o.id)).not.toContain(ownerUnassigned);
  }, 30_000);
});
