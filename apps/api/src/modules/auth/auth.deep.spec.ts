/**
 * Phase 2 deep audit suite.
 *
 * Encodes the SPEC-CORRECT expected behaviour. Tests wrapped in `it.fails`
 * document a CONFIRMED bug (the spec-correct assertion currently fails) so the
 * suite stays green while the defect inventory lives in code. When a bug is
 * fixed, remove the `.fails` and the test guards the fix.
 *
 * Bug refs map to the Phase 2 audit (see PROGRESS.md / PR review).
 */
import { db, providerDb, withTenant } from '@emapp/db';
import { ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';
import { auth } from './better-auth.instance';

vi.mock('@emapp/config', () => ({
  serverEnv: {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-at-least-44-chars-long-for-jwt-testing',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-chars',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  },
}));

vi.mock('@emapp/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockReturnThis(),
    transaction: vi.fn().mockResolvedValue(undefined),
  },
  providerDb: { transaction: vi.fn().mockResolvedValue(undefined) },
  baSession: { token: 'token', userId: 'userId', expiresAt: 'expiresAt' },
  users: { id: 'id', name: 'name', email: 'email', avatarColor: 'avatarColor' },
  memberships: { userId: 'userId', orgId: 'orgId', role: 'role', revokedAt: 'revoked_at' },
  organizations: { id: 'id', name: 'name' },
  withTenant: vi.fn().mockResolvedValue(undefined),
  AuditService: vi.fn().mockImplementation(() => ({ log: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('./better-auth.instance', () => ({
  auth: { api: { signUpEmail: vi.fn(), signInEmail: vi.fn() } },
}));

const BA_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'a@test.com',
  name: 'A',
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  image: null,
};

function svc() {
  return new AuthService(new JwtService({ secret: 'test-secret-at-least-32-chars-long-enough' }));
}

function profileChain(rows: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.select as any).mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
        }),
      }),
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  profileChain([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 1 — signup leaves an orphaned ba_user when the domain bootstrap fails.
// signUpEmail commits in its own store; providerDb.transaction is a separate
// store/tx with NO compensation. Spec: signup must be atomic or compensate.
// ─────────────────────────────────────────────────────────────────────────────
describe('signup atomicity', () => {
  it.fails('BUG1: rolls back / compensates the auth user when domain bootstrap fails', async () => {
    vi.mocked(auth.api.signUpEmail).mockResolvedValue({
      user: BA_USER,
      token: 't',
      redirect: false,
    } as never);
    vi.mocked(providerDb.transaction).mockRejectedValueOnce?.(new Error('bootstrap failed'));
    // some vitest typings lack mockRejectedValueOnce on the mock proxy:
    vi.mocked(providerDb.transaction).mockRejectedValue(new Error('bootstrap failed'));

    await expect(
      svc().signup({ org_name: 'O', name: 'A', email: 'a@test.com', password: 'TestPass1234' }),
    ).rejects.toThrow();

    // SPEC-CORRECT: the orphaned ba_user must be cleaned up.
    const cleanedUp =
      vi.mocked(db.delete).mock.calls.length > 0 ||
      Object.prototype.hasOwnProperty.call(auth.api, 'deleteUser');
    expect(cleanedUp).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2 — brittle conflict detection: a NON-email unique violation is
// misclassified as email_taken because of substring matching on 'unique'.
// ─────────────────────────────────────────────────────────────────────────────
describe('signup conflict classification', () => {
  it.fails('BUG2: a non-email unique violation must NOT be reported as email_taken', async () => {
    vi.mocked(auth.api.signUpEmail).mockRejectedValue(
      new Error('duplicate key value violates unique constraint "ba_user_phone_unique"'),
    );
    // SPEC-CORRECT: this is not an email conflict — must not be a 409 email_taken.
    await expect(
      svc().signup({ org_name: 'O', name: 'A', email: 'a@test.com', password: 'TestPass1234' }),
    ).rejects.not.toThrow(ConflictException);
  });

  it('a genuine "already exists" error maps to ConflictException', async () => {
    vi.mocked(auth.api.signUpEmail).mockRejectedValue(new Error('User already exists'));
    await expect(
      svc().signup({ org_name: 'O', name: 'A', email: 'a@test.com', password: 'TestPass1234' }),
    ).rejects.toThrow(ConflictException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3 — refresh token issuance is fire-and-forget: signup/login resolve
// BEFORE the ba_session row is persisted. A client can receive a refresh
// token that is not yet (or never) valid.
// ─────────────────────────────────────────────────────────────────────────────
describe('refresh token persistence', () => {
  it.fails('BUG3: signup awaits refresh-token persistence before returning', async () => {
    vi.mocked(auth.api.signUpEmail).mockResolvedValue({
      user: BA_USER,
      token: 't',
      redirect: false,
    } as never);
    vi.mocked(providerDb.transaction).mockResolvedValue(undefined as never);

    let sessionPersisted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.insert as any).mockReturnValue({
      values: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              sessionPersisted = true;
              resolve(undefined);
            }, 10);
          }),
      ),
    });

    await svc().signup({ org_name: 'O', name: 'A', email: 'a@test.com', password: 'TestPass1234' });
    // SPEC-CORRECT: by the time signup resolves, the session must be persisted.
    expect(sessionPersisted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 4 — switchOrg does not rotate the refresh token and writes NO audit
// entry, even though changing the active org is a security-relevant authz
// change (spec: org switch must be audited).
// ─────────────────────────────────────────────────────────────────────────────
describe('switchOrg auditing', () => {
  it.fails('BUG4: switchOrg writes an audit log entry', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ role: 'manager' }]) }),
      }),
    });
    await svc().switchOrg(BA_USER.id, '00000000-0000-0000-0000-000000000002');
    expect(vi.mocked(withTenant)).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 5 — refresh has NO reuse detection. Spec: replay of an already-rotated
// refresh token is a theft signal → revoke all sessions. Here an unknown /
// rotated token simply 401s with no global revocation or audit.
// ─────────────────────────────────────────────────────────────────────────────
describe('refresh reuse detection', () => {
  it.fails('BUG5: replaying a rotated refresh token revokes all user sessions', async () => {
    // No session row found (token already rotated away).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    });
    await expect(svc().refresh('stolen-rotated-token')).rejects.toThrow();
    // SPEC-CORRECT: a reuse attempt must trigger a global session purge.
    expect(vi.mocked(db.delete)).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Positive guards — behaviour that IS correct today (regression protection).
// ─────────────────────────────────────────────────────────────────────────────
describe('access token claims (regression guard)', () => {
  it('login issues an access token with sub/orgId/role/type=access', async () => {
    vi.mocked(auth.api.signInEmail).mockResolvedValue({
      user: BA_USER,
      token: 't',
      redirect: false,
    } as never);
    profileChain([
      {
        userId: BA_USER.id,
        userName: 'A',
        userEmail: 'a@test.com',
        avatarColor: '#0f766e',
        role: 'manager',
        orgId: '00000000-0000-0000-0000-000000000002',
        orgName: 'O',
      },
    ]);
    const jwt = new JwtService({ secret: 'test-secret-at-least-32-chars-long-enough' });
    const result = await new AuthService(jwt).login({ email: 'a@test.com', password: 'x' });
    const payload = jwt.decode(result.accessToken) as Record<string, unknown>;
    expect(payload['sub']).toBe(BA_USER.id);
    expect(payload['type']).toBe('access');
    expect(payload['role']).toBe('manager');
  });
});
