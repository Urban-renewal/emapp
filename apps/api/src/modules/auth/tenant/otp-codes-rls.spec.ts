/**
 * M1 — otp_codes RLS (migration 0050). otp_codes had an app_user DML grant + an
 * org_id column but NO row-level security, so inside any `withTenant` tx (which
 * does SET LOCAL ROLE app_user) a query could read OTHER orgs' OTP rows. 0050
 * adds the same tenant_isolation policy owners/ownerships carry.
 *
 * The OTP service is UNAFFECTED — it reads/writes otp_codes via the raw `db`
 * connecting role (BYPASSRLS) pre-auth (covered by otp-suspension.spec). This
 * test pins the OTHER side: as app_user (inside withTenant) a cross-org read is
 * now impossible.
 */
import { otpCodes, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../../packages/db/test/setup';

let orgA: TestOrg;
let orgB: TestOrg;

/** Seed an otp_codes row for an org via the BYPASSRLS provider pool (raw SQL —
 *  app_user can no longer INSERT cross-org, which is exactly the point). */
async function seedOtpRow(orgId: string, phoneHash: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query(
      `INSERT INTO otp_codes (phone_hash, code_hash, org_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '5 minutes') RETURNING id`,
      [phoneHash, 'c'.repeat(64), orgId],
    );
    return (r.rows[0] as { id: string }).id;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `m1-otp-rls-${Date.now()}`;
  orgA = await createTestOrg(`${tag}-a`, `${tag}-a`);
  orgB = await createTestOrg(`${tag}-b`, `${tag}-b`);
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('M1 — otp_codes RLS (0050) scopes app_user to its own org', () => {
  it('inside withTenant(orgA), app_user sees orgA OTP rows but NOT orgB rows', async () => {
    const idA = await seedOtpRow(orgA.id, 'a'.repeat(64));
    const idB = await seedOtpRow(orgB.id, 'b'.repeat(64));

    // withTenant drops to app_user + sets app.organization_id=orgA → RLS applies.
    const seenByA = await withTenant(orgA.id, async (tx) =>
      tx.select({ id: otpCodes.id, orgId: otpCodes.orgId }).from(otpCodes),
    );

    const ids = seenByA.map((r) => r.id);
    expect(ids).toContain(idA); // own-org row visible
    expect(ids).not.toContain(idB); // cross-org row INVISIBLE — the 0050 fix
    expect(seenByA.every((r) => r.orgId === orgA.id)).toBe(true);
  }, 30_000);

  it('symmetric: withTenant(orgB) sees orgB OTP rows but NOT orgA rows', async () => {
    const idA = await seedOtpRow(orgA.id, 'd'.repeat(64));
    const idB = await seedOtpRow(orgB.id, 'e'.repeat(64));

    const seenByB = await withTenant(orgB.id, async (tx) =>
      tx.select({ id: otpCodes.id, orgId: otpCodes.orgId }).from(otpCodes),
    );

    const ids = seenByB.map((r) => r.id);
    expect(ids).toContain(idB);
    expect(ids).not.toContain(idA);
    expect(seenByB.every((r) => r.orgId === orgB.id)).toBe(true);
  }, 30_000);
});
