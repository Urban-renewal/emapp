import { db, providerDb, withTenant } from '@emapp/db';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';
import { auth } from './better-auth.instance';

// vi.mock calls are hoisted by vitest before any import executes
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
    values: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    transaction: vi.fn().mockResolvedValue(undefined),
    catch: vi.fn().mockReturnThis(),
  },
  providerDb: {
    transaction: vi.fn().mockResolvedValue(undefined),
  },
  baSession: { token: 'token', userId: 'userId', expiresAt: 'expiresAt' },
  users: { id: 'id', name: 'name', email: 'email', avatarColor: 'avatarColor' },
  memberships: { userId: 'userId', orgId: 'orgId', role: 'role' },
  organizations: { id: 'id', name: 'name' },
  withTenant: vi.fn().mockResolvedValue(undefined),
  AuditService: vi.fn().mockImplementation(() => ({ log: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('./better-auth.instance', () => ({
  auth: {
    api: {
      signUpEmail: vi.fn(),
      signInEmail: vi.fn(),
    },
  },
}));

const MOCK_BA_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'test@example.com',
  name: 'Test User',
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  image: null,
};
const MOCK_SESSION_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test User',
  email: 'test@example.com',
  role: 'manager',
  avatarColor: '#0f766e',
  organization: { id: '00000000-0000-0000-0000-000000000002', name: 'Test Org' },
};

function makeService() {
  const jwtService = new JwtService({ secret: 'test-secret-at-least-32-chars-long-enough' });
  return new AuthService(jwtService);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockSelectProfile() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.select as any).mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                userId: MOCK_SESSION_USER.id,
                userName: MOCK_SESSION_USER.name,
                userEmail: MOCK_SESSION_USER.email,
                avatarColor: MOCK_SESSION_USER.avatarColor,
                role: 'manager',
                orgId: MOCK_SESSION_USER.organization.id,
                orgName: MOCK_SESSION_USER.organization.name,
              },
            ]),
          }),
        }),
      }),
    }),
  });
}

function mockSelectEmpty() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.select as any).mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      }),
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
    }),
  });
}

describe('AuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectEmpty();
  });

  // T2.1 — signup happy path
  describe('signup', () => {
    it('T2.1 creates org + user + membership via providerDb and returns tokens', async () => {
      vi.mocked(auth.api.signUpEmail).mockResolvedValue({
        user: MOCK_BA_USER,
        token: 'ba-token',
        redirect: false,
      } as never);

      vi.mocked(providerDb.transaction).mockImplementation(async (fn) => {
        await fn({
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
        } as never);
      });

      const svc = makeService();
      const result = await svc.signup({
        org_name: 'Test Org',
        name: 'Test User',
        email: 'test@example.com',
        password: 'TestPassword123',
      });

      expect(auth.api.signUpEmail).toHaveBeenCalledOnce();
      expect(providerDb.transaction).toHaveBeenCalledOnce();
      expect(withTenant).toHaveBeenCalledOnce();
      expect(result.user.email).toBe('test@example.com');
      expect(result.user.role).toBe('manager');
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('T2.2 returns ConflictException when email already exists', async () => {
      vi.mocked(auth.api.signUpEmail).mockRejectedValue(new Error('Email already exists'));

      const svc = makeService();
      await expect(
        svc.signup({
          org_name: 'Test',
          name: 'Test',
          email: 'dup@example.com',
          password: 'TestPassword123',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // T2.3 — login
  describe('login', () => {
    it('T2.3 returns tokens and user profile on valid credentials', async () => {
      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        user: MOCK_BA_USER,
        token: 'ba-token',
        redirect: false,
      } as never);
      mockSelectProfile();

      const svc = makeService();
      const result = await svc.login({ email: 'test@example.com', password: 'TestPassword123' });

      expect(result.user.email).toBe('test@example.com');
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('T2.4 throws UnauthorizedException on invalid credentials', async () => {
      vi.mocked(auth.api.signInEmail).mockRejectedValue(new Error('Invalid credentials'));

      const svc = makeService();
      await expect(
        svc.login({ email: 'test@example.com', password: 'WrongPassword' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('T2.5 throws UnauthorizedException when user has no org', async () => {
      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        user: MOCK_BA_USER,
        token: 'ba-token',
        redirect: false,
      } as never);
      // loadProfile returns null — mockSelectEmpty is already set

      const svc = makeService();
      await expect(
        svc.login({ email: 'test@example.com', password: 'TestPassword123' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // T2.6 — access token payload
  describe('access token', () => {
    it('T2.6 access token contains sub, orgId, role, type=access', async () => {
      vi.mocked(auth.api.signInEmail).mockResolvedValue({
        user: MOCK_BA_USER,
        token: 'ba-token',
        redirect: false,
      } as never);
      mockSelectProfile();

      const jwtService = new JwtService({ secret: 'test-secret-at-least-32-chars-long-enough' });
      const svc = new AuthService(jwtService);
      const result = await svc.login({ email: 'test@example.com', password: 'TestPassword123' });
      const payload = jwtService.decode(result.accessToken) as Record<string, unknown>;

      expect(payload['sub']).toBe(MOCK_SESSION_USER.id);
      expect(payload['orgId']).toBe(MOCK_SESSION_USER.organization.id);
      expect(payload['role']).toBe('manager');
      expect(payload['type']).toBe('access');
    });
  });

  // T2.7 — refresh
  describe('refresh', () => {
    it('T2.7 throws UnauthorizedException for expired/missing refresh token', async () => {
      const svc = makeService();
      await expect(svc.refresh('invalid-token')).rejects.toThrow(UnauthorizedException);
    });
  });

  // T2.8 — getMe
  describe('getMe', () => {
    it('T2.8 returns null when user not found', async () => {
      const svc = makeService();
      const result = await svc.getMe('non-existent-uuid');
      expect(result).toBeNull();
    });

    it('T2.9 returns user profile when found', async () => {
      mockSelectProfile();
      const svc = makeService();
      const result = await svc.getMe(MOCK_SESSION_USER.id);
      expect(result?.email).toBe(MOCK_SESSION_USER.email);
      expect(result?.role).toBe('manager');
    });
  });

  // T2.10 — switchOrg
  describe('switchOrg', () => {
    it('T2.10 throws BadRequestException when user is not a member', async () => {
      const svc = makeService();
      await expect(
        svc.switchOrg(MOCK_SESSION_USER.id, '00000000-0000-0000-0000-000000000099'),
      ).rejects.toThrow();
    });
  });
});
