/**
 * D.49 — a suspended org's contractor shares are INERT.
 *
 * The contractor-facing consumption endpoint is not built yet (deferred —
 * see shares.service.ts header), so the testable invariant is at the share-
 * resolution seam every caller funnels through: `assertProjectVisible`. With
 * the org suspended, EVERY share operation 404s — indistinguishable from a
 * non-existent project. When the contractor tier lands it resolves through the
 * same `isOrgSuspended` gate, so the property holds for it by construction.
 *
 * Mechanism (D.51 — a plaster can't pass): the SAME project that lists fine
 * while active returns 404 once suspended, and works again after reactivate —
 * proving the gate is the suspension flag, not some unrelated visibility rule.
 */
import { defaultSharePermissions } from '@emapp/db';
import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SharesService } from './shares.service';

let svc: SharesService;
let org: TestOrg;
let projectId: string;

function manager(): AccessTokenPayload {
  return {
    sub: org.users[0]!.id,
    orgId: org.id,
    role: 'manager',
    // audit_log.session_id is a uuid column — must be a valid UUID (the
    // create/update/revoke paths write an audit row with this sid).
    sid: '00000000-0000-4000-8000-000000000001',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function setSuspended(orgId: string, suspended: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE organizations SET suspended_at = ${suspended ? 'now()' : 'NULL'} WHERE id = $1`,
      [orgId],
    );
  } finally {
    c.release();
  }
}

async function seedContractor(orgId: string, createdBy: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO contractors (org_id, name, contact_email, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, 'Test Contractor', `c-${Date.now()}@test.local`, createdBy],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SharesService();
  const tag = `d49-share-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  projectId = org.projects[0]!.id;
}, 90_000);

afterAll(() => {
  /* pools are shared singletons; global teardown closes them */
});

describe('D.49 — suspended org → contractor shares inert (shares.service)', () => {
  it('D49-SHARE-1) active org: project share list resolves (sanity)', async () => {
    await setSuspended(org.id, false);
    const page = await svc.list(manager(), projectId, { limit: 10 });
    expect(Array.isArray(page.data)).toBe(true);
  });

  it('D49-SHARE-2) suspended org: the SAME project share list → 404 (inert)', async () => {
    await setSuspended(org.id, true);
    await expect(svc.list(manager(), projectId, { limit: 10 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('D49-SHARE-3) reactivated org: share list resolves again', async () => {
    await setSuspended(org.id, false);
    const page = await svc.list(manager(), projectId, { limit: 10 });
    expect(Array.isArray(page.data)).toBe(true);
  });

  it('D49-SHARE-4) suspended org: update + revoke of an EXISTING share → 404 (by-id write paths gated too)', async () => {
    // The by-id write paths don't pass through assertProjectVisible, so they
    // gate isOrgSuspended directly. Prove the SAME share that is reachable
    // while active becomes inert under suspension, and reachable again after.
    await setSuspended(org.id, false);
    const contractorId = await seedContractor(org.id, org.users[0]!.id);
    const share = await svc.create(manager(), projectId, {
      contractorId,
      permissions: defaultSharePermissions(),
    });

    await setSuspended(org.id, true);
    await expect(
      svc.update(manager(), share.id, { permissions: defaultSharePermissions() }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.revoke(manager(), share.id)).rejects.toBeInstanceOf(NotFoundException);

    // Reactivate → the share is reachable again (proves the 404s were the
    // suspension gate, not a missing/invisible share).
    await setSuspended(org.id, false);
    await expect(svc.revoke(manager(), share.id)).resolves.toBeUndefined();
  }, 30_000);
});
