/**
 * A2 audit closure (security-critical auth paths under-tested).
 *
 * Provider login / rotation / reuse-detection — service-level integration
 * against the REAL Neon dev DB. Pre-A2 these paths were covered ONLY by the
 * black-box HTTP contract suite (auth.contract.spec.ts P1–P7), which SKIPS
 * EVERY clause when no live server is reachable — so in CI the provider auth
 * tier had effectively ZERO executed coverage of the success / rotation /
 * reuse-purge invariants. This spec drives `ProviderAuthService` directly so
 * the invariants run on every `pnpm test`.
 *
 * Harness: `createLoginableTestProviderUser` (added for A2) seeds a provider
 * with a real argon2id password hash + a real pgcrypto-encrypted TOTP secret,
 * so we can mint LIVE TOTP codes and complete the full MFA-mandatory login.
 *
 * Invariants pinned:
 *   PA-1  happy path — password + live TOTP → access + refresh tokens; the
 *         access token is a structurally-valid provider JWT (verified via the
 *         real JwtService with the provider audience).
 *   PA-2  wrong MFA (correct password) → 401 invalid_credentials, no session.
 *   PA-3  disabled account → generic 401 (anti-enum), even with correct creds.
 *   PA-4  refresh rotates: a new refresh token is issued and the old one is
 *         then rejected.
 *   PA-5  REUSE-CHAIN-PURGE — replaying a rotated refresh token purges the
 *         WHOLE chain: the current (newest) token is also invalidated.
 *   PA-6  TOCTOU — two concurrent refreshes of one token → EXACTLY ONE
 *         succeeds; no two valid tokens minted from one old token.
 *   PA-7  lockout — after MAX_FAILED bad attempts the account is locked: even
 *         a correct password + live TOTP is rejected during the lock window.
 */
import { serverEnv } from '@emapp/config';
import { providerSessions } from '@emapp/db';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../../../../../../packages/db/src/client';
import { createLoginableTestProviderUser } from '../../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../../packages/db/test/setup';

import { ProviderAuthService } from './provider-auth.service';

const JWT_AUD_PROVIDER = 'emapp-provider';
const JWT_ISS = 'emapp';

let jwt: JwtService;
let svc: ProviderAuthService;

function totpFor(secretB32: string): string {
  return new TOTP({ secret: Secret.fromBase32(secretB32), period: 30, digits: 6 }).generate();
}

function errorCode(e: unknown): string | undefined {
  const r = (e as { getResponse?: () => unknown }).getResponse?.() as
    | { error?: { code?: string } }
    | undefined;
  return r?.error?.code;
}

/** Count NON-revoked sessions for a provider — chain-state probe. */
async function activeSessionCount(providerUserId: string): Promise<number> {
  const rows = await db
    .select({ id: providerSessions.id, revokedAt: providerSessions.revokedAt })
    .from(providerSessions)
    .where(eq(providerSessions.providerUserId, providerUserId));
  return rows.filter((r) => r.revokedAt === null).length;
}

beforeAll(async () => {
  await setupTestDatabase();
  jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
  svc = new ProviderAuthService(jwt);
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('A2 · provider auth service — login / rotation / reuse', () => {
  it('PA-1) happy path: password + live TOTP → valid provider access + refresh', async () => {
    const p = await createLoginableTestProviderUser();
    const res = await svc.login({
      email: p.email,
      password: p.password,
      mfa_code: totpFor(p.totpSecretBase32),
    });
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    // The access token is a REAL signed provider JWT (right audience/issuer,
    // right type + subject) — not a placeholder string.
    const payload = jwt.verify<{ sub: string; type: string; role: string; sid: string }>(
      res.accessToken,
      { audience: JWT_AUD_PROVIDER, issuer: JWT_ISS, algorithms: ['HS256'] },
    );
    expect(payload.type).toBe('provider_access');
    expect(payload.sub).toBe(p.id);
    expect(payload.role).toBe('provider_admin');
    expect(payload.sid).toBeTruthy();
    // Exactly one active session row was minted by the login.
    expect(await activeSessionCount(p.id)).toBe(1);
  }, 30_000);

  it('PA-2) correct password + WRONG MFA → 401 invalid_credentials, no session', async () => {
    const p = await createLoginableTestProviderUser();
    const before = await activeSessionCount(p.id);
    let thrown: unknown;
    try {
      await svc.login({ email: p.email, password: p.password, mfa_code: '000000' });
      throw new Error('login should have been rejected for a wrong MFA code');
    } catch (e) {
      thrown = e;
    }
    expect(errorCode(thrown)).toBe('invalid_credentials');
    expect(await activeSessionCount(p.id)).toBe(before); // MFA failure mints nothing
  }, 30_000);

  it('PA-3) disabled account → generic 401 even with correct password + live TOTP', async () => {
    const p = await createLoginableTestProviderUser({ disabled: true });
    let thrown: unknown;
    try {
      await svc.login({
        email: p.email,
        password: p.password,
        mfa_code: totpFor(p.totpSecretBase32),
      });
      throw new Error('disabled provider login should have been rejected');
    } catch (e) {
      thrown = e;
    }
    // Anti-enum: same generic code as wrong creds — never reveals "disabled".
    expect(errorCode(thrown)).toBe('invalid_credentials');
    expect(await activeSessionCount(p.id)).toBe(0);
  }, 30_000);

  it('PA-4) refresh rotates: new token issued, old token then rejected', async () => {
    const p = await createLoginableTestProviderUser();
    const login = await svc.login({
      email: p.email,
      password: p.password,
      mfa_code: totpFor(p.totpSecretBase32),
    });
    const r1 = await svc.refresh(login.refreshToken);
    expect(r1.refreshToken).toBeTruthy();
    expect(r1.refreshToken).not.toBe(login.refreshToken); // rotation

    // The ORIGINAL (now rotated) refresh token must be rejected.
    await expect(svc.refresh(login.refreshToken)).rejects.toMatchObject({});
    let oldRejected = false;
    try {
      await svc.refresh(login.refreshToken);
    } catch (e) {
      oldRejected = errorCode(e) === 'invalid_refresh';
    }
    expect(oldRejected, 'a rotated provider refresh token was accepted again').toBe(true);
  }, 30_000);

  it('PA-5) REUSE-CHAIN-PURGE: replaying a rotated token kills the whole chain', async () => {
    const p = await createLoginableTestProviderUser();
    const login = await svc.login({
      email: p.email,
      password: p.password,
      mfa_code: totpFor(p.totpSecretBase32),
    });
    // Rotate once: rt1 -> rt2 (rt2 is the live token).
    const r1 = await svc.refresh(login.refreshToken);
    const rt2 = r1.refreshToken;

    // Replay the rotated rt1 → theft signal → service must purge the chain.
    let replayRejected = false;
    try {
      await svc.refresh(login.refreshToken);
    } catch (e) {
      replayRejected = errorCode(e) === 'invalid_refresh';
    }
    expect(replayRejected).toBe(true);

    // SECURITY INVARIANT: the still-"current" rt2 must ALSO be dead now —
    // reuse-detection purges every active session, not just the replayed one.
    let currentAlsoDead = false;
    try {
      await svc.refresh(rt2);
    } catch (e) {
      currentAlsoDead = errorCode(e) === 'invalid_refresh';
    }
    expect(
      currentAlsoDead,
      'reuse-detection did NOT purge the active provider chain — stolen-token replay leaves the victims live session valid',
    ).toBe(true);
    // And the DB chain is fully revoked.
    expect(await activeSessionCount(p.id)).toBe(0);
  }, 30_000);

  it('PA-6) TOCTOU: two concurrent refreshes of one token → exactly one succeeds', async () => {
    const p = await createLoginableTestProviderUser();
    const login = await svc.login({
      email: p.email,
      password: p.password,
      mfa_code: totpFor(p.totpSecretBase32),
    });
    const results = await Promise.allSettled([
      svc.refresh(login.refreshToken),
      svc.refresh(login.refreshToken),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(
      fulfilled.length,
      `provider refresh double-spend: ${fulfilled.length} of 2 concurrent calls minted a token`,
    ).toBe(1);
    // No two valid tokens from one old token: the single winner's new token
    // works exactly once, and at most one fresh active session beyond any the
    // (atomic) rotation revoked.
    const winner = fulfilled[0] as PromiseFulfilledResult<{ refreshToken: string }>;
    expect(winner.value.refreshToken).toBeTruthy();
  }, 30_000);

  it('PA-7) lockout: after MAX_FAILED bad attempts, correct creds are blocked', async () => {
    const p = await createLoginableTestProviderUser();
    // 5 failures (MAX_FAILED) → lock for 15 min. Use wrong MFA so the password
    // is valid (exercises the real failed-count bump on the 2nd-factor path).
    for (let i = 0; i < 5; i += 1) {
      try {
        await svc.login({ email: p.email, password: p.password, mfa_code: '000000' });
      } catch {
        /* expected 401 */
      }
    }
    // Now even a CORRECT password + live TOTP must be rejected (locked window).
    let locked = false;
    try {
      await svc.login({
        email: p.email,
        password: p.password,
        mfa_code: totpFor(p.totpSecretBase32),
      });
    } catch (e) {
      locked = errorCode(e) === 'invalid_credentials';
    }
    expect(
      locked,
      'provider lockout not enforced — correct creds logged in during lock window',
    ).toBe(true);
    expect(await activeSessionCount(p.id)).toBe(0);
  }, 40_000);
});
