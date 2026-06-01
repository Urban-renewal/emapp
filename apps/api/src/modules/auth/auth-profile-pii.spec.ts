/**
 * D2-DEF-3 / D.54 — `GET /me` exposes `view_owner_pii` so the FE can offer
 * the owner "Reveal PII" button only to actors who can actually reveal.
 *
 * Mechanism (a plaster can't pass): drives `AuthService.getMe` directly
 * against real DB rows seeded with each role + capability combination, and
 * asserts the resolved flag matches the BE reveal gate exactly:
 *   - manager                       → true (always unmasked)
 *   - agent WITH view_owner_pii     → true
 *   - agent WITHOUT view_owner_pii  → false (the DEF-3 case — the button
 *                                     must NOT show for a flag-less agent)
 *   - viewer                        → false (never)
 */
import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import { AuthService } from './auth.service';

let svc: AuthService;
let org: TestOrg;

const AGENT_CAPS_ON = {
  edit_project_data: false,
  manage_documents: false,
  manage_signatures: false,
  manage_tasks: false,
  run_imports: false,
  view_owners: true,
  view_owner_pii: true,
};
const AGENT_CAPS_OFF = { ...AGENT_CAPS_ON, view_owner_pii: false };

/** Insert a user + an accepted membership (role + capabilities) via the
 *  BYPASSRLS provider pool; returns the new userId. */
async function seedMember(
  orgId: string,
  role: 'manager' | 'agent' | 'viewer',
  capabilities: Record<string, boolean>,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const email = `def3-${role}-${randomUUID()}@test.local`;
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [email, `${role} user`],
    );
    const userId = u.rows[0]!.id;
    await c.query(
      `INSERT INTO memberships (user_id, org_id, role, capabilities, accepted_at)
       VALUES ($1, $2, $3, $4::jsonb, now())`,
      [userId, orgId, role, JSON.stringify(capabilities)],
    );
    return userId;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new AuthService(new JwtService({ secret: serverEnv.JWT_SECRET }));
  org = await createTestOrg(`def3-${Date.now()}`, `def3-${Date.now()}`);
}, 90_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

describe('D2-DEF-3 — getMe view_owner_pii', () => {
  it('manager → view_owner_pii = true', async () => {
    const id = await seedMember(org.id, 'manager', AGENT_CAPS_OFF);
    const me = await svc.getMe(id);
    expect(me?.role).toBe('manager');
    expect(me?.view_owner_pii).toBe(true);
  });

  it('agent WITH the capability → true', async () => {
    const id = await seedMember(org.id, 'agent', AGENT_CAPS_ON);
    const me = await svc.getMe(id);
    expect(me?.role).toBe('agent');
    expect(me?.view_owner_pii).toBe(true);
  });

  it('agent WITHOUT the capability → false (the DEF-3 gap)', async () => {
    const id = await seedMember(org.id, 'agent', AGENT_CAPS_OFF);
    const me = await svc.getMe(id);
    expect(me?.role).toBe('agent');
    expect(me?.view_owner_pii).toBe(false);
  });

  it('viewer → false (never)', async () => {
    const id = await seedMember(org.id, 'viewer', AGENT_CAPS_ON);
    const me = await svc.getMe(id);
    expect(me?.role).toBe('viewer');
    expect(me?.view_owner_pii).toBe(false);
  });

  it('revoked membership → getMe returns null (no stale capability)', async () => {
    const id = await seedMember(org.id, 'agent', AGENT_CAPS_ON);
    const c = await providerPool.connect();
    try {
      await c.query(`UPDATE memberships SET revoked_at = now() WHERE user_id = $1`, [id]);
    } finally {
      c.release();
    }
    // loadProfile filters revoked_at IS NULL → no active membership → null.
    expect(await svc.getMe(id)).toBeNull();
  });
});
