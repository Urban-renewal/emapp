/**
 * D.54 — view_owners gate + PII fidelity on the apartment-owners surface
 * (`GET /apartments/:id/owners` → OwnershipsService.listApartmentOwners).
 * The owner-bearing surface MUST enforce the same uniform rule as /owners:
 *
 * - agent assigned to the apartment's project but WITHOUT view_owners → 403
 *   (sees the apartment, but NO owners).
 * - agent WITH view_owners, NOT view_owner_pii → masked, no cleartext field.
 * - agent WITH view_owners + view_owner_pii → cleartext in the dedicated fields,
 *   `nationalIdMasked` STAYS masked.
 * - manager → cleartext; viewer → masked. (Deterministic real-DB.)
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
import { ForbiddenException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnershipsService } from './ownerships.service';

let svc: OwnershipsService;
let org: TestOrg;
let managerId: string;
let agentId: string;
let apartmentId: string;
let ownerId: string;

const NID = '111111118';
const PHONE = '0541239876';
const SID = '00000000-0000-4000-8000-0000000000c2';

function tok(role: 'manager' | 'agent' | 'viewer'): AccessTokenPayload {
  return {
    sub: role === 'agent' ? agentId : managerId,
    orgId: org.id,
    role,
    sid: SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
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

async function q1(sql: string, params: unknown[]): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(sql, params);
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new OwnershipsService();
  const tag = `d54own-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  const projectId = org.projects[0]!.id;

  const [u] = await db
    .insert(users)
    .values({ email: `a-${randomUUID()}@test.local`, name: 'Agent', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  agentId = u!.id;
  await db
    .insert(memberships)
    .values({ userId: agentId, orgId: org.id, role: 'agent', acceptedAt: new Date() });
  await db.insert(projectAssignments).values({ projectId, userId: agentId, assignedBy: managerId });

  const buildingId = await q1(
    `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, 'TLV') RETURNING id`,
    [projectId, `St-${randomUUID()}`],
  );
  apartmentId = await q1(
    `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
    [buildingId, randomUUID().slice(0, 8)],
  );
  ownerId = await withTenant(org.id, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: NID,
      name: 'בעלים',
      phone: PHONE,
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
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
  await q1(
    `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct) VALUES ($1, $2, 100.00) RETURNING id`,
    [apartmentId, ownerId],
  );
}, 120_000);

describe('D.54 — apartment-owners view_owners gate (masked for everyone)', () => {
  it('AO-1) agent assigned but WITHOUT view_owners → 403 (sees apartment, not owners)', async () => {
    await setCaps(false, false);
    await expect(
      svc.listApartmentOwners(tok('agent'), apartmentId, { limit: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('AO-2) agent WITH view_owners → masked, no cleartext (even with view_owner_pii)', async () => {
    await setCaps(true, true); // pii flag does NOT unmask the list — reveal-on-demand only
    const page = await svc.listApartmentOwners(tok('agent'), apartmentId, { limit: 10 });
    const o = page.data.find((r) => r.id === ownerId)!;
    expect(o.nationalIdMasked).toBe('•••••••18');
    expect(JSON.stringify(page.data)).not.toContain(NID); // no cleartext on this surface
  }, 30_000);

  it('AO-3) manager + viewer → masked (no cleartext on the apartment-owners list)', async () => {
    const m = (await svc.listApartmentOwners(tok('manager'), apartmentId, { limit: 10 })).data.find(
      (r) => r.id === ownerId,
    )!;
    expect(m.nationalIdMasked).toBe('•••••••18');
    const v = (await svc.listApartmentOwners(tok('viewer'), apartmentId, { limit: 10 })).data.find(
      (r) => r.id === ownerId,
    )!;
    expect(v.nationalIdMasked).toBe('•••••••18');
    expect(JSON.stringify([m, v])).not.toContain(NID);
  }, 30_000);
});
