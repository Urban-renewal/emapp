/**
 * P1 R0.1 — self-service password reset (OWASP Forgot-Password) service-level
 * integration against the REAL Neon dev DB. Drives `AuthService.forgotPassword`
 * + `AuthService.resetPassword` directly so the OWASP invariants run on every
 * `pnpm test` (the black-box HTTP contract suite skips without a live server).
 *
 * Invariants pinned:
 *   PR-1  ANTI-ENUMERATION — forgotPassword for an UNKNOWN email is a silent
 *         no-op (no token row minted, no throw). Same observable outcome as the
 *         happy path (the controller returns a fixed 200 either way).
 *   PR-2  HASHED TOKEN — the stored row carries ONLY a sha256 hash, never the
 *         raw token (a DB leak yields no usable link).
 *   PR-3  HAPPY PATH — a valid token resets the password (new hash verifies,
 *         old hash no longer does) and the token is marked used.
 *   PR-4  SINGLE-USE — replaying a consumed token is rejected (generic error),
 *         and a second distinct reset cannot reuse the first token.
 *   PR-5  EXPIRY — an expired token is rejected (generic error).
 *   PR-6  SESSION-PURGE — a successful reset revokes ALL the user's active
 *         auth_sessions (mirror of logout).
 *   PR-7  WRONG/UNKNOWN TOKEN — a never-issued token is rejected generically.
 */
import { serverEnv } from '@emapp/config';
import { authSessions, db, passwordResetTokens, users, FakeEmailProvider } from '@emapp/db';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { PermissionService } from '../../common/authz/permission.service';
import { noopBreachForTest, noopMetricsForTest } from '../observability/test-doubles';

import { AuthService } from './auth.service';
import { hashPassword, verifyPassword } from './password';
import {
  PasswordResetRepository,
  hashResetToken,
  newRawResetToken,
} from './password-reset.repository';
import { createSession, newRawToken } from './session.repository';

let svc: AuthService;
let repo: PasswordResetRepository;
let userId: string;
let email: string;
const OLD_PASSWORD = 'old-password-123456';
const NEW_PASSWORD = 'brand-new-password-789012';

function errorCode(e: unknown): string | undefined {
  const r = (e as { getResponse?: () => unknown }).getResponse?.() as
    | { error?: { code?: string } }
    | undefined;
  return r?.error?.code;
}

async function activeSessionCount(uid: string): Promise<number> {
  const rows = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(and(eq(authSessions.userId, uid), isNull(authSessions.revokedAt)));
  return rows.length;
}

/** Mint a token directly via the repo and return BOTH the raw + its row id. */
async function mintToken(uid: string): Promise<string> {
  const raw = await repo.mint(db, uid, '203.0.113.7');
  if (!raw) throw new Error('mint returned null (cap hit?)');
  return raw;
}

beforeAll(async () => {
  await setupTestDatabase();
  repo = new PasswordResetRepository();
  svc = new AuthService(
    new JwtService({ secret: serverEnv.JWT_SECRET }),
    new PermissionService(),
    noopMetricsForTest(),
    noopBreachForTest(),
    new FakeEmailProvider(),
    repo,
  );
  email = `pwreset-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const passwordHash = await hashPassword(OLD_PASSWORD);
  const [u] = await db
    .insert(users)
    .values({ email, name: 'Reset Tester', passwordHash })
    .returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  // Best-effort cleanup of this test's rows (the user cascade-deletes its
  // tokens + sessions).
  await db.delete(users).where(eq(users.id, userId));
});

describe('password reset (OWASP Forgot-Password)', () => {
  it('PR-1 anti-enumeration: unknown email is a silent no-op', async () => {
    const before = await db.select({ id: passwordResetTokens.id }).from(passwordResetTokens);
    await expect(
      svc.forgotPassword({ email: `nobody-${Date.now()}@test.local` }, '203.0.113.1'),
    ).resolves.toBeUndefined();
    const after = await db.select({ id: passwordResetTokens.id }).from(passwordResetTokens);
    // No new token row for a non-existent account.
    expect(after.length).toBe(before.length);
  });

  it('PR-2 hashed token: the stored row never holds the raw token', async () => {
    const raw = await mintToken(userId);
    const [row] = await db
      .select({ tokenHash: passwordResetTokens.tokenHash })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashResetToken(raw)))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.tokenHash).toBe(hashResetToken(raw));
    expect(row!.tokenHash).not.toBe(raw); // raw is never stored
    // cleanup this token so it doesn't pollute later counts
    await db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashResetToken(raw)));
  });

  it('PR-3/PR-6 happy path: resets the password + purges sessions', async () => {
    // Seed two active sessions for the user.
    await db.transaction(async (tx) => {
      await createSession(tx as never, userId, newRawToken());
      await createSession(tx as never, userId, newRawToken());
    });
    expect(await activeSessionCount(userId)).toBeGreaterThanOrEqual(2);

    const raw = await mintToken(userId);
    await expect(
      svc.resetPassword({ token: raw, newPassword: NEW_PASSWORD }),
    ).resolves.toBeUndefined();

    const [u] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(await verifyPassword(u!.passwordHash!, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(u!.passwordHash!, OLD_PASSWORD)).toBe(false);

    // Session purge — every active session revoked.
    expect(await activeSessionCount(userId)).toBe(0);

    // Token marked used.
    const [row] = await db
      .select({ usedAt: passwordResetTokens.usedAt })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashResetToken(raw)))
      .limit(1);
    expect(row!.usedAt).not.toBeNull();
  });

  it('PR-4 single-use: a consumed token cannot be replayed', async () => {
    const raw = await mintToken(userId);
    await svc.resetPassword({ token: raw, newPassword: 'first-reset-abcdef-1' });
    let code: string | undefined;
    try {
      await svc.resetPassword({ token: raw, newPassword: 'replay-attempt-abc-2' });
      throw new Error('expected replay to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnauthorizedException);
      code = errorCode(e);
    }
    expect(code).toBe('invalid_reset_token');
  });

  it('PR-5 expiry: an expired token is rejected', async () => {
    const raw = newRawResetToken();
    await db.insert(passwordResetTokens).values({
      userId,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(Date.now() - 60_000), // already expired
    });
    let code: string | undefined;
    try {
      await svc.resetPassword({ token: raw, newPassword: 'should-not-apply-abc' });
      throw new Error('expected expired token to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnauthorizedException);
      code = errorCode(e);
    }
    expect(code).toBe('invalid_reset_token');
  });

  it('PR-7 unknown token: a never-issued token is rejected generically', async () => {
    let code: string | undefined;
    try {
      await svc.resetPassword({ token: newRawResetToken(), newPassword: 'no-such-token-abc1' });
      throw new Error('expected unknown token to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnauthorizedException);
      code = errorCode(e);
    }
    expect(code).toBe('invalid_reset_token');
  });
});
