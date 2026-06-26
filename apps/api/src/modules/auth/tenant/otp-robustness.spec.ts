/**
 * SLICE 0.S5 — OTP robustness (red-team #19/#41 + #8).
 *
 * Service-level integration against the REAL local/Neon dev DB. Pins the two
 * confirmed red-team defects in the tenant SMS-OTP path:
 *
 *   OR-1  ATOMIC lockout (#19/#41) — the brute-force counter was a non-atomic
 *         read-modify-write (SELECT then a separate UPDATE, no row lock), so
 *         concurrent wrong guesses interleaved and could bypass MAX_ATTEMPTS.
 *         Invariant: fire MANY simultaneous wrong guesses at ONE fresh OTP row;
 *         the row's `attempts` must settle at EXACTLY MAX_ATTEMPTS (never more),
 *         the row must be consumed (used_at set), and a correct code presented
 *         afterward must be rejected. The SELECT…FOR UPDATE inside one tx
 *         serializes the guesses so the limit holds.
 *
 *   OR-2  no timing oracle (#8) — `request()` awaited the SMS gateway send
 *         INLINE before returning, so a registered phone (real send, ~gateway
 *         RTT) was measurably slower than an unknown phone (no send), leaking
 *         existence. Invariant: with an SMS fake whose send() BLOCKS forever,
 *         `request()` for a KNOWN phone still RESOLVES (it does not await the
 *         send); and an UNKNOWN phone resolves the same way. Neither blocks on
 *         the gateway → no enumeration oracle.
 *
 * The SMS provider is a controllable fake. No PII (phone / code) is ever logged.
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

const MAX_ATTEMPTS = 5; // mirror of OtpService.MAX_ATTEMPTS (private const)

function key(): string {
  return dbEnv.PII_HASH_KEY as string;
}

function errorCode(e: unknown): string | undefined {
  const r = (e as UnauthorizedException).getResponse() as { error?: { code?: string } };
  return r.error?.code;
}

/** Capturing SMS fake — instantly resolves 'sent', records count. Never logs PII. */
class InstantSms implements ISMSProvider {
  public sends = 0;
  async send(_to: string, _body: string): Promise<{ status: 'sent'; id: string }> {
    this.sends += 1;
    return { status: 'sent', id: `fake-${this.sends}` };
  }
  async healthCheck(): Promise<void> {
    /* always healthy */
  }
}

/**
 * SMS fake whose send() BLOCKS until manually released. Used to prove that
 * `request()` does NOT await the send (OR-2). `started` flips true the moment
 * the gateway call begins; the returned promise never settles until release().
 */
class BlockingSms implements ISMSProvider {
  public started = 0;
  private resolvers: Array<() => void> = [];
  async send(_to: string, _body: string): Promise<{ status: 'sent'; id: string }> {
    this.started += 1;
    await new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
    return { status: 'sent', id: 'blocked' };
  }
  async healthCheck(): Promise<void> {
    /* always healthy */
  }
  /** Release all pending sends so dangling promises don't leak across tests. */
  release(): void {
    for (const r of this.resolvers) r();
    this.resolvers = [];
  }
}

let org: TestOrg;
let jwt: JwtService;
let orgSlug: string;
let ownerSeq = 0;

function validIsraeliId(base8: number): string {
  const body = String(base8 % 100_000_000).padStart(8, '0');
  for (let check = 0; check < 10; check += 1) {
    const candidate = body + String(check);
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid Israeli ID check digit found');
}

async function seedOwner(): Promise<{ ownerId: string; phone: string }> {
  ownerSeq += 1;
  const rawPhone = `050${String(Date.now()).slice(-4)}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`;
  const phone = normalizeIsraeliPhone(rawPhone)!;
  const nationalId = validIsraeliId(20_000_000 + ownerSeq + (Date.now() % 1_000_000));
  const ownerId = await withTenant(org.id, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId,
      name: 'דייר OTP-ROBUST',
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

/** Insert a known-code OTP row directly (BYPASSRLS); returns nothing. */
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

/** Read the latest otp_codes row for a phone — attempts + whether consumed. */
async function readOtpRow(phone: string): Promise<{ attempts: number; used: boolean }> {
  const phoneHash = hashField(normalizeIsraeliPhone(phone)!, key());
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ attempts: number; used_at: string | null }>(
      `SELECT attempts, used_at FROM otp_codes
       WHERE phone_hash = $1 ORDER BY created_at DESC LIMIT 1`,
      [phoneHash],
    );
    const row = r.rows[0]!;
    return { attempts: Number(row.attempts), used: row.used_at !== null };
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
  const tag = `s5-otp-robust-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ slug: string }>(`SELECT slug FROM organizations WHERE id = $1`, [
      org.id,
    ]);
    orgSlug = r.rows[0]!.slug;
  } finally {
    c.release();
  }
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('0.S5 · OTP robustness — atomic lockout (#19/#41) + no timing oracle (#8)', () => {
  it('OR-1) ATOMIC lockout: N concurrent wrong guesses cannot exceed MAX_ATTEMPTS', async () => {
    const svc = new OtpService(jwt, new InstantSms());
    const { ownerId, phone } = await seedOwner();
    const correct = '135790';
    await seedOtpCode(ownerId, phone, correct); // attempts = 0, fresh

    // Fire many MORE simultaneous wrong guesses than the limit. Pre-fix these
    // would interleave (all read the same attempts value) and the row could
    // end with attempts < MAX or, worse, never reach the cap so the correct
    // code stays valid. With the SELECT…FOR UPDATE tx they serialize.
    const CONCURRENCY = 12;
    const guesses = Array.from({ length: CONCURRENCY }, () =>
      svc.verify(phone, '000000').then(
        () => 'accepted' as const,
        (e: unknown) =>
          errorCode(e) === 'invalid_otp' ? ('rejected' as const) : ('other' as const),
      ),
    );
    const outcomes = await Promise.all(guesses);

    // Every wrong guess must be rejected — none accepted, none a 500.
    expect(outcomes.every((o) => o === 'rejected')).toBe(true);

    // The counter settled at EXACTLY the cap (atomic) — never above it — and
    // the row is consumed so it can't be reused.
    const after = await readOtpRow(phone);
    expect(after.attempts, 'attempts must settle at exactly MAX_ATTEMPTS (atomic)').toBe(
      MAX_ATTEMPTS,
    );
    expect(after.used, 'row must be consumed once the cap is hit').toBe(true);

    // And the CORRECT code presented afterward is now rejected — lockout holds.
    let correctRejected = false;
    try {
      await svc.verify(phone, correct);
    } catch (e) {
      correctRejected = errorCode(e) === 'invalid_otp';
    }
    expect(
      correctRejected,
      'correct code accepted after attempts exhausted (lockout bypassed)',
    ).toBe(true);
  }, 40_000);

  it('OR-2) no timing oracle: request() resolves WITHOUT awaiting the SMS send (known phone)', async () => {
    const blocking = new BlockingSms();
    const svc = new OtpService(jwt, blocking);
    const { phone } = await seedOwner();

    // The fake's send() blocks forever. If request() awaited it inline, this
    // await would hang. It must resolve in DB-bound time — proving the send is
    // fire-and-forget (no enumeration timing leak).
    await expect(
      Promise.race([
        svc.request(phone, orgSlug).then(() => 'resolved' as const),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5_000)),
      ]),
    ).resolves.toBe('resolved');

    // The send WAS dispatched (started) — just not awaited before the return.
    expect(blocking.started, 'the SMS send should still be dispatched (just not awaited)').toBe(1);
    blocking.release(); // avoid a dangling promise leaking into other tests
  }, 20_000);

  it('OR-2b) no timing oracle: KNOWN and UNKNOWN phones both resolve, neither blocks on the gateway', async () => {
    const blocking = new BlockingSms();
    const svc = new OtpService(jwt, blocking);
    const { phone: knownPhone } = await seedOwner();
    // An unknown phone: valid Israeli format, but no owner row exists for it.
    const unknownPhone = normalizeIsraeliPhone(
      `0509${String(Date.now()).slice(-3)}${Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, '0')}`,
    )!;

    const both = await Promise.race([
      Promise.all([svc.request(knownPhone, orgSlug), svc.request(unknownPhone, orgSlug)]).then(
        () => 'both-resolved' as const,
      ),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5_000)),
    ]);
    expect(both, 'known + unknown phone requests must both resolve without blocking').toBe(
      'both-resolved',
    );

    // The unknown phone triggered NO send (no owner); the known phone dispatched
    // exactly one (fire-and-forget). The caller could not have distinguished
    // them by wall-clock — both returned promptly above.
    expect(blocking.started, 'only the known phone dispatches a send').toBe(1);
    blocking.release();
  }, 20_000);
});
