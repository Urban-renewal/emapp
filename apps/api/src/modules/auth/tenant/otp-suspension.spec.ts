/**
 * D.49 — a suspended org freezes the RESIDENT (tenant SMS-OTP) portal.
 *
 * Drives `OtpService.verify()` directly against a seeded owner + a known OTP
 * row (deterministic real-DB; the contract suite skips without a live server).
 *
 * Mechanism (D.51 — a plaster can't pass):
 *   D49-OTP-1  active org + correct code → tenant access token issued (sanity).
 *   D49-OTP-2  suspended org + CORRECT code → 401 `invalid_otp` (generic — we
 *              do NOT disclose org suspension to an external resident), and no
 *              session token is minted.
 *   D49-OTP-3  reactivated org + correct code → token issued again.
 * The same correct code flips active→reject→active purely on the suspension
 * flag, so a plaster that ignored `suspended_at` would fail D49-OTP-2.
 */
import { serverEnv } from '@emapp/config';
import { env as dbEnv, encryptOwnerPii, hashField, owners, withTenant } from '@emapp/db';
import type { ISMSProvider } from '@emapp/db';
import { normalizeIsraeliPhone } from '@emapp/validators';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../../packages/db/test/setup';

import { OtpService } from './otp.service';

const CODE = '123456';
const PHONE = '050' + String(Date.now()).slice(-7);

let svc: OtpService;
let org: TestOrg;
let ownerId: string;

function key(): string {
  return dbEnv.PII_HASH_KEY as string;
}

async function seedOwnerWithPhone(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: '000000018',
      name: 'דייר OTP',
      phone: PHONE,
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

/** Insert a fresh, valid (unused, unexpired) OTP row for the seeded owner. */
async function seedOtp(): Promise<void> {
  const phoneHash = hashField(normalizeIsraeliPhone(PHONE)!, key());
  const codeHash = hashField(CODE, key());
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO otp_codes (phone_hash, code_hash, owner_id, org_id, expires_at, attempts)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes', 0)`,
      [phoneHash, codeHash, ownerId, org.id],
    );
  } finally {
    c.release();
  }
}

async function setSuspended(suspended: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE organizations SET suspended_at = ${suspended ? 'now()' : 'NULL'} WHERE id = $1`,
      [org.id],
    );
  } finally {
    c.release();
  }
}

async function countTenantSessions(owner: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_sessions WHERE owner_id = $1`,
      [owner],
    );
    return Number(r.rows[0]!.n);
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
  const sms = {} as unknown as ISMSProvider; // verify() never calls the SMS provider
  svc = new OtpService(new JwtService({ secret: serverEnv.JWT_SECRET }), sms);
  const tag = `d49-otp-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  ownerId = await seedOwnerWithPhone(org.id);
}, 90_000);

afterAll(() => {
  /* pools are shared singletons; global teardown closes them */
});

describe('D.49 — suspended org freezes the resident OTP portal (otp.service)', () => {
  it('D49-OTP-1) active org + correct code → tenant access token (sanity)', async () => {
    await setSuspended(false);
    await seedOtp();
    const res = await svc.verify(PHONE, CODE);
    expect(res.accessToken).toBeTruthy();
  });

  it('D49-OTP-2) suspended org + CORRECT code → 401 invalid_otp, no token minted', async () => {
    await setSuspended(true);
    await seedOtp();
    const sessionsBefore = await countTenantSessions(ownerId);
    let thrown: unknown;
    try {
      await svc.verify(PHONE, CODE);
      throw new Error('OTP verify should have been rejected for a suspended org');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    // Generic code — residents are external; suspension is not disclosed.
    expect(codeOf(thrown)).toBe('invalid_otp');
    // No tenant_session minted during the blocked verify (the resident is NOT
    // logged in despite supplying the correct code).
    expect(await countTenantSessions(ownerId)).toBe(sessionsBefore);
  });

  it('D49-OTP-3) reactivated org + correct code → token issued again', async () => {
    await setSuspended(false);
    await seedOtp();
    const res = await svc.verify(PHONE, CODE);
    expect(res.accessToken).toBeTruthy();
  });
});
