/**
 * A2 audit closure (security-critical auth paths under-tested).
 *
 * Org-tier (owned auth stack, D.21) refresh ROTATION + REUSE-DETECTION +
 * concurrent TOCTOU — service-level integration against the REAL Neon dev DB.
 *
 * Pre-A2 these invariants were asserted only in the black-box HTTP contract
 * suite (auth.contract.spec.ts D4 + D9), which SKIPS every clause when no live
 * server is reachable. In CI without a server the reuse-chain-purge and the
 * double-refresh TOCTOU therefore had ZERO executed coverage. This spec drives
 * `AuthService.refresh` directly so both run on every `pnpm test`.
 *
 * Invariants pinned:
 *   RR-1  rotation — refresh issues a NEW token and the old token is rejected.
 *   RR-2  REUSE-CHAIN-PURGE — replaying a rotated (stale) token must invalidate
 *         the WHOLE session chain (every active session revoked), not just the
 *         one token. The still-"current" token is also killed.
 *   RR-3  TOCTOU — two concurrent refreshes of the SAME token: exactly ONE
 *         succeeds; no two valid new tokens are minted from one old token.
 */
import { serverEnv } from '@emapp/config';
import { authSessions, FakeEmailProvider } from '@emapp/db';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { PermissionService } from '../../common/authz/permission.service';
import { noopBreachForTest, noopMetricsForTest } from '../observability/test-doubles';

import { AuthService } from './auth.service';
import { PasswordResetRepository } from './password-reset.repository';
import { newRawToken, createSession } from './session.repository';

let svc: AuthService;
let org: TestOrg;
let userId: string;

function errorCode(e: unknown): string | undefined {
  const r = (e as { getResponse?: () => unknown }).getResponse?.() as
    | { error?: { code?: string } }
    | undefined;
  return r?.error?.code;
}

/** Mint a real session row for the seeded user and return its raw refresh token. */
async function freshSessionToken(): Promise<string> {
  const raw = newRawToken();
  await db.transaction(async (tx) => {
    await createSession(tx as never, userId, raw);
  });
  return raw;
}

async function activeSessionCount(): Promise<number> {
  const rows = await db
    .select({ id: authSessions.id, revokedAt: authSessions.revokedAt })
    .from(authSessions)
    .where(eq(authSessions.userId, userId));
  return rows.filter((r) => r.revokedAt === null).length;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new AuthService(
    new JwtService({ secret: serverEnv.JWT_SECRET }),
    new PermissionService(),
    noopMetricsForTest(),
    noopBreachForTest(),
    new FakeEmailProvider(),
    new PasswordResetRepository(),
  );
  const tag = `a2-refresh-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  userId = org.users[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('A2 · org auth refresh — rotation / reuse-purge / TOCTOU', () => {
  it('RR-1) rotation: refresh issues a new token; the old token is rejected', async () => {
    const raw = await freshSessionToken();
    const r1 = await svc.refresh(raw);
    expect(r1.refreshToken).toBeTruthy();
    expect(r1.refreshToken).not.toBe(raw); // rotated

    let oldRejected = false;
    try {
      await svc.refresh(raw);
    } catch (e) {
      oldRejected = errorCode(e) === 'invalid_refresh';
    }
    expect(oldRejected, 'a rotated org refresh token was accepted again').toBe(true);
  }, 30_000);

  it('RR-2) REUSE-CHAIN-PURGE: replaying a rotated token kills the whole chain', async () => {
    const raw = await freshSessionToken();
    // Rotate once: raw -> rt2 (rt2 is the live token).
    const r1 = await svc.refresh(raw);
    const rt2 = r1.refreshToken;

    // Replay the stale `raw` → theft signal → service must purge the chain.
    let replayRejected = false;
    try {
      await svc.refresh(raw);
    } catch (e) {
      replayRejected = errorCode(e) === 'invalid_refresh';
    }
    expect(replayRejected).toBe(true);

    // SECURITY INVARIANT (D.21): the still-"current" rt2 must ALSO be dead —
    // reuse-detection purges every active session for the user, not just the
    // replayed token. If rt2 still worked, a stolen-token replay would leave
    // the victim's live session usable.
    let currentAlsoDead = false;
    try {
      await svc.refresh(rt2);
    } catch (e) {
      currentAlsoDead = errorCode(e) === 'invalid_refresh';
    }
    expect(
      currentAlsoDead,
      'reuse-detection did NOT purge the active chain — the victims current refresh token is still valid after a replay',
    ).toBe(true);
    expect(await activeSessionCount()).toBe(0);
  }, 30_000);

  it('RR-3) TOCTOU: two concurrent refreshes of one token → exactly one succeeds', async () => {
    const raw = await freshSessionToken();
    const results = await Promise.allSettled([svc.refresh(raw), svc.refresh(raw)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(
      fulfilled.length,
      `org refresh double-spend: ${fulfilled.length} of 2 concurrent calls minted a token — atomic rotation broken`,
    ).toBe(1);
    const winner = fulfilled[0] as PromiseFulfilledResult<{ refreshToken: string }>;
    expect(winner.value.refreshToken).toBeTruthy();
    expect(winner.value.refreshToken).not.toBe(raw);
  }, 30_000);
});
