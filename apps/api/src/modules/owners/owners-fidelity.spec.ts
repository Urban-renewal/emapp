/**
 * D.54 (reveal-on-demand) — view_owners gate + reveal-pii. Deterministic real-DB.
 *
 * - agent WITHOUT view_owners → full deny (403) on list/get/search.
 * - agent WITH view_owners → sees ONLY owners in assigned projects (scoped),
 *   ALWAYS masked (no cleartext on list/detail/search, for any role).
 * - cleartext is reveal-on-demand: POST /owners/:id/reveal-pii (svc.revealPii)
 *   returns clear national_id/phone of ONE owner, gated by view_owner_pii
 *   (manager always · agent per flag · viewer never) + owner-in-assigned-project
 *   scope, and writes a per-access audit row (owner.pii_revealed, ISO A.12.4).
 */
import { randomUUID } from 'node:crypto';

import {
  auditLog,
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
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
const PHONE_ASSIGNED = '+972541239876';
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
  ownerUnassigned = await seedOwner(org.id, '222222226', '+972500000000');
  await seedOwnership(aptU, ownerUnassigned);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('D.54 — view_owners gate + masked list/detail (no cleartext anywhere)', () => {
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
    expect(JSON.stringify(page.data)).not.toContain(NID_ASSIGNED); // no cleartext anywhere
  }, 30_000);

  it('DV-3) get is masked for EVERY role (manager/viewer/pii-agent included)', async () => {
    await setCaps(true, true); // even with view_owner_pii, the JSON detail stays masked
    for (const u of [tok('agent'), tok('manager'), tok('viewer')]) {
      const o = await svc.get(u, ownerAssigned);
      expect(o.nationalIdMasked).toBe('•••••••18');
      expect(JSON.stringify(o)).not.toContain(NID_ASSIGNED);
    }
  }, 30_000);

  it('DV-5) agent WITH view_owners → get an owner in an UNASSIGNED project → 404 (scope)', async () => {
    await setCaps(true, true);
    await expect(svc.get(tok('agent'), ownerUnassigned)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('DV-8) search honours scope + masking (agent assigned-only, masked)', async () => {
    await setCaps(true, false);
    const res = await svc.search(tok('agent'), { national_id: NID_ASSIGNED });
    expect(res.map((o) => o.id)).toContain(ownerAssigned);
    expect(res.every((o) => o.nationalIdMasked.startsWith('•'))).toBe(true);
    const res2 = await svc.search(tok('agent'), { national_id: '222222226' });
    expect(res2.map((o) => o.id)).not.toContain(ownerUnassigned);
  }, 30_000);
});

describe('D.54 — reveal-on-demand (POST /owners/:id/reveal-pii)', () => {
  it('RV-1) agent WITH view_owner_pii + assigned owner → cleartext', async () => {
    await setCaps(true, true);
    const r = await svc.revealPii(tok('agent'), ownerAssigned);
    expect(r).toEqual({ id: ownerAssigned, nationalId: NID_ASSIGNED, phone: PHONE_ASSIGNED });
  });

  it('RV-2) agent WITH view_owners but NOT view_owner_pii → 403', async () => {
    await setCaps(true, false);
    await expect(svc.revealPii(tok('agent'), ownerAssigned)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('RV-3) agent WITH view_owner_pii but owner UNASSIGNED → 404 (scope, no oracle)', async () => {
    await setCaps(true, true);
    await expect(svc.revealPii(tok('agent'), ownerUnassigned)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('RV-4) manager → cleartext (always unmasked)', async () => {
    const r = await svc.revealPii(tok('manager'), ownerAssigned);
    expect(r.nationalId).toBe(NID_ASSIGNED);
    expect(r.phone).toBe(PHONE_ASSIGNED);
  });

  it('RV-5) viewer → 403 (never reveals)', async () => {
    await expect(svc.revealPii(tok('viewer'), ownerAssigned)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('RV-6) a successful reveal writes a per-access audit row, WITHOUT cleartext', async () => {
    await svc.revealPii(tok('manager'), ownerAssigned);
    const [row] = await db
      .select({ action: auditLog.action, afterState: auditLog.afterState })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, ownerAssigned), eq(auditLog.action, 'owner.pii_revealed')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row, 'no owner.pii_revealed audit row').toBeTruthy();
    expect(JSON.stringify(row!.afterState)).not.toContain(NID_ASSIGNED); // field names only
    expect((row!.afterState as { revealed: string[] }).revealed).toContain('national_id');
  }, 30_000);
});
