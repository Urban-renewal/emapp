/**
 * A2 audit closure (security-critical auth paths under-tested).
 *
 * Tenant SMS-OTP security invariants (D.20 / GATE 4) — service-level
 * integration against the REAL Neon dev DB. Pre-A2 the service-level OTP
 * coverage was only the happy/suspended path (otp-suspension.spec.ts). The
 * rate-limit, the used-code replay block, the bad-attempt lockout, and a
 * positive "valid token is actually minted + a session row created" assertion
 * were FULLY MISSING at the service level (they existed only in the black-box
 * HTTP contract suite, which skips entirely in CI without a live server).
 *
 * Invariants pinned:
 *   OS-1  rate-limit — 3 SMS / 15 min / phone: the 4th request inside the
 *         window writes NO new otp_codes row (throttled).
 *   OS-2  replay — a USED code (usedAt set on success) cannot be verified
 *         again → 401 invalid_otp.
 *   OS-3  happy path — correct, fresh code → a tenant access token is minted
 *         AND a tenant_sessions row is created (own-record-only, no refresh).
 *   OS-4  lockout — after MAX_ATTEMPTS (5) wrong codes the row is consumed:
 *         even the CORRECT code afterwards → 401 invalid_otp.
 *
 * The SMS provider is a capturing fake so OS-1 can assert delivery happened
 * for the first N and stopped at the limit, without a real gateway. No PII
 * (phone / code) is ever logged by the test.
 */
import { serverEnv } from '@emapp/config';
import {
  env as dbEnv,
  encryptOwnerPii,
  hashField,
  owners,
  type ISMSProvider,
  withTenant,
} from '@emapp/db';
import { isValidIsraeliId, normalizeIsraeliPhone } from '@emapp/validators';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../../packages/db/test/setup';

import { OtpService } from './otp.service';

const JWT_AUD_TENANT = 'emapp-tenant';
const JWT_ISS = 'emapp';

/** Capturing SMS fake — records sends so we can prove rate-limit cutoff.
 *  Never logs the `to` (phone PII) or `body` (contains the OTP code). */
class CapturingSms implements ISMSProvider {
  public sends = 0;
  async send(_to: string, _body: string): Promise<{ status: 'sent'; id: string }> {
    this.sends += 1;
    return { status: 'sent', id: `fake-${this.sends}` };
  }
  async healthCheck(): Promise<void> {
    /* always healthy */
  }
}

let svc: OtpService;
let jwt: JwtService;
let sms: CapturingSms;
let org: TestOrg;

function key(): string {
  return dbEnv.PII_HASH_KEY as string;
}

function errorCode(e: unknown): string | undefined {
  const r = (e as UnauthorizedException).getResponse() as { error?: { code?: string } };
  return r.error?.code;
}

// Monotonic counter so each seeded owner in the same org gets a DISTINCT,
// checksum-valid national_id (the per-org `owners_org_natid_unique_active`
// constraint rejects duplicates).
let ownerSeq = 0;

/** Build a checksum-valid 9-digit Israeli national_id from an 8-digit base, by
 *  appending whichever check digit (0–9) satisfies the real validator. */
function validIsraeliId(base8: number): string {
  const body = String(base8 % 100_000_000).padStart(8, '0');
  for (let check = 0; check < 10; check += 1) {
    const candidate = body + String(check);
    if (isValidIsraeliId(candidate)) return candidate;
  }
  // A valid check digit always exists; this is unreachable.
  throw new Error('no valid Israeli ID check digit found');
}

/** Seed an owner with a unique high-entropy phone; returns {ownerId, phone}. */
async function seedOwner(): Promise<{ ownerId: string; phone: string }> {
  ownerSeq += 1;
  const rawPhone = `050${String(Date.now()).slice(-4)}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`;
  // The owner row must store the NORMALIZED (E.164) phone hash, because the
  // service derives its lookup hash via normalizeIsraeliPhone(). Store the
  // canonical form so `request()` resolves the owner (matches the production
  // write path, which normalizes before encrypting).
  const phone = normalizeIsraeliPhone(rawPhone)!;
  const nationalId = validIsraeliId(10_000_000 + ownerSeq + (Date.now() % 1_000_000));
  const ownerId = await withTenant(org.id, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId,
      name: 'דייר OTP-SEC',
      phone,
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
  return { ownerId, phone };
}

/** Insert a known-code OTP row directly (BYPASSRLS) and return the code. */
async function seedOtpCode(
  ownerId: string,
  phone: string,
  code: string,
  opts?: { attempts?: number },
): Promise<void> {
  const phoneHash = hashField(normalizeIsraeliPhone(phone)!, key());
  const codeHash = hashField(code, key());
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO otp_codes (phone_hash, code_hash, owner_id, org_id, expires_at, attempts)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes', $5)`,
      [phoneHash, codeHash, ownerId, org.id, opts?.attempts ?? 0],
    );
  } finally {
    c.release();
  }
}

/** Count otp_codes rows created in the rate-limit window for a phone. */
async function countOtpRowsInWindow(phone: string): Promise<number> {
  const phoneHash = hashField(normalizeIsraeliPhone(phone)!, key());
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM otp_codes
       WHERE phone_hash = $1 AND created_at > now() - interval '15 minutes'`,
      [phoneHash],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

async function countTenantSessions(ownerId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_sessions WHERE owner_id = $1`,
      [ownerId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
  sms = new CapturingSms();
  svc = new OtpService(jwt, sms);
  const tag = `a2-otp-sec-${Date.now()}`;
  org = await createTestOrg(tag, tag);
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('A2 · tenant OTP security — rate-limit / replay / success / lockout', () => {
  it('OS-1) rate-limit: 3 SMS / 15 min / phone — the 4th request is throttled (no new row)', async () => {
    const { phone } = await seedOwner();
    // org_slug pins THIS org so the F2 multi-org disambiguation can't no-op
    // on a phone collision with another org in the shared dev DB.
    const orgSlug = await resolveOrgSlug();

    const before = sms.sends;
    // 3 allowed sends.
    for (let i = 0; i < 3; i += 1) await svc.request(phone, orgSlug);
    const after3 = await countOtpRowsInWindow(phone);
    expect(after3, 'expected exactly 3 OTP rows after 3 requests in-window').toBe(3);
    expect(sms.sends - before, 'SMS provider should have been hit 3×').toBe(3);

    // 4th request inside the window: throttled — NO new row, NO new SMS.
    await svc.request(phone, orgSlug);
    const after4 = await countOtpRowsInWindow(phone);
    expect(
      after4,
      'the 4th in-window OTP request was NOT throttled (rate limit not enforced)',
    ).toBe(3);
    expect(sms.sends - before, 'a 4th SMS was sent past the 3/15min limit').toBe(3);
  }, 40_000);

  it('OS-2) replay: a USED code (usedAt set on success) cannot be verified again', async () => {
    const { ownerId, phone } = await seedOwner();
    const code = '424242';
    await seedOtpCode(ownerId, phone, code);

    // First verify succeeds and consumes the code (usedAt set).
    const ok = await svc.verify(phone, code);
    expect(ok.accessToken).toBeTruthy();

    // Replay the same code → must be rejected (the row is now usedAt-set, and
    // verify only considers rows WHERE used_at IS NULL).
    let replayRejected = false;
    try {
      await svc.verify(phone, code);
    } catch (e) {
      replayRejected = errorCode(e) === 'invalid_otp';
    }
    expect(replayRejected, 'a used OTP code was accepted on replay').toBe(true);
  }, 30_000);

  it('OS-3) happy path: correct code → tenant access token + a tenant_sessions row', async () => {
    const { ownerId, phone } = await seedOwner();
    const code = '314159';
    await seedOtpCode(ownerId, phone, code);

    const before = await countTenantSessions(ownerId);
    const res = await svc.verify(phone, code);
    expect(res.accessToken).toBeTruthy();
    // The token is a REAL signed tenant JWT (right audience/issuer/type/sub).
    const payload = jwt.verify<{ sub: string; type: string; role: string; orgId: string }>(
      res.accessToken,
      { audience: JWT_AUD_TENANT, issuer: JWT_ISS, algorithms: ['HS256'] },
    );
    expect(payload.type).toBe('tenant_access');
    expect(payload.role).toBe('tenant');
    expect(payload.sub).toBe(ownerId);
    expect(payload.orgId).toBe(org.id);
    // A session row was actually created (own-record-only; no refresh token).
    expect(await countTenantSessions(ownerId)).toBe(before + 1);
  }, 30_000);

  it('OS-4) lockout: after MAX_ATTEMPTS (5) wrong codes, the correct code is rejected', async () => {
    const { ownerId, phone } = await seedOwner();
    const correct = '271828';
    // Seed with attempts already at 4 so the next WRONG try reaches 5
    // (MAX_ATTEMPTS) and consumes the row; then the correct code must fail.
    await seedOtpCode(ownerId, phone, correct, { attempts: 4 });

    // One wrong attempt → attempts becomes 5 → row consumed (usedAt set).
    let firstWrongRejected = false;
    try {
      await svc.verify(phone, '999999');
    } catch (e) {
      firstWrongRejected = errorCode(e) === 'invalid_otp';
    }
    expect(firstWrongRejected).toBe(true);

    // Now the CORRECT code must also be rejected — the row is exhausted/used.
    let correctNowRejected = false;
    try {
      await svc.verify(phone, correct);
    } catch (e) {
      correctNowRejected = errorCode(e) === 'invalid_otp';
    }
    expect(
      correctNowRejected,
      'OTP attempt-limit not enforced — correct code accepted after attempts exhausted',
    ).toBe(true);
    // No session minted across the whole lockout sequence.
    expect(await countTenantSessions(ownerId)).toBe(0);
  }, 30_000);
});

/** Resolve the org's real slug (createTestOrg sets slug = tag). */
async function resolveOrgSlug(): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ slug: string }>(`SELECT slug FROM organizations WHERE id = $1`, [
      org.id,
    ]);
    return r.rows[0]!.slug;
  } finally {
    c.release();
  }
}
