/**
 * D.49 — org-suspension login enforcement (auth.service integration).
 *
 * Slice 2 of provider-write: a suspended org (organizations.suspended_at != null)
 * must REJECT new org logins. This is the companion to the session-revocation
 * proven in provider-tenant-suspension.spec.ts (D49-SUSP-REVOKE).
 *
 * Deterministic (real DB, no live server — unlike auth.contract.spec.ts which
 * skips without a running API). Drives `AuthService.login()` directly against a
 * seeded manager with a REAL argon2 hash.
 *
 * Mechanism criteria (D.51 — a plaster can't pass):
 *   D49-LOGIN-2  suspended org + VALID creds → 401 `org_suspended`, no token.
 *   D49-LOGIN-3  suspended org + WRONG creds → generic `invalid_credentials`
 *                (the suspension check runs AFTER password verification, so it
 *                is never an enumeration oracle).
 *   D49-LOGIN-4  reactivated org → login works again.
 */
import { serverEnv } from '@emapp/config';
import { db, users } from '@emapp/db';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { PermissionService } from '../../common/authz/permission.service';
import { noopBreachForTest, noopMetricsForTest } from '../observability/test-doubles';

import { AuthService } from './auth.service';
import { hashPassword } from './password';

const PW = 'SuspendTest123456';
let svc: AuthService;
let org: TestOrg;
let email: string;

async function setSuspended(orgId: string, suspended: boolean): Promise<void> {
  // BYPASSRLS pool — pre-auth there is no app.organization_id GUC, so an
  // appPool UPDATE would be filtered out by RLS. Mirrors the detail-spec
  // pattern for mutating org rows in tests.
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE organizations
         SET suspended_at = ${suspended ? 'now()' : 'NULL'},
             suspended_reason = ${suspended ? `'test suspend'` : 'NULL'}
       WHERE id = $1`,
      [orgId],
    );
  } finally {
    c.release();
  }
}

function codeOf(e: unknown): string | undefined {
  const r = (e as UnauthorizedException).getResponse() as { error?: { code?: string } };
  return r.error?.code;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new AuthService(
    new JwtService({ secret: serverEnv.JWT_SECRET }),
    new PermissionService(),
    noopMetricsForTest(),
    noopBreachForTest(),
  );
  const tag = `d49-login-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  email = `manager-${org.id}@test.local`;
  // The factory seeds a placeholder hash; give the manager a REAL argon2 hash
  // so password verification passes and we actually reach the suspension gate.
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(PW) })
    .where(eq(users.id, org.users[0]!.id));
}, 90_000);

afterAll(() => {
  /* pools are shared singletons; global teardown closes them */
});

describe('D.49 — org suspension blocks org login (auth.service)', () => {
  it('D49-LOGIN-1) active org + valid creds → login succeeds (sanity)', async () => {
    await setSuspended(org.id, false);
    const res = await svc.login({ email, password: PW });
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(res.user.organization.id).toBe(org.id);
  });

  it('D49-LOGIN-2) suspended org + valid creds → 401 org_suspended, no token issued', async () => {
    await setSuspended(org.id, true);
    let thrown: unknown;
    try {
      await svc.login({ email, password: PW });
      throw new Error('login should have been rejected for a suspended org');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(codeOf(thrown)).toBe('org_suspended');
  });

  it('D49-LOGIN-3) suspended org + WRONG creds → generic invalid_credentials (no oracle)', async () => {
    // Suspension is checked AFTER password verification, so a wrong password
    // must NOT reveal that the org is suspended.
    let thrown: unknown;
    try {
      await svc.login({ email, password: 'WrongPassword999' });
      throw new Error('wrong password should have been rejected');
    } catch (e) {
      thrown = e;
    }
    expect(codeOf(thrown)).toBe('invalid_credentials');
  });

  it('D49-LOGIN-4) reactivated org + valid creds → login succeeds again', async () => {
    await setSuspended(org.id, false);
    const res = await svc.login({ email, password: PW });
    expect(res.accessToken).toBeTruthy();
    expect(res.user.organization.id).toBe(org.id);
  });
});
