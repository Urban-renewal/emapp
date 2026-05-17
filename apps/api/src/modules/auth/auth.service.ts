import { randomBytes, randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  AuditService,
  baSession,
  db,
  memberships,
  organizations,
  providerDb,
  users,
  withTenant,
} from '@emapp/db';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, gt } from 'drizzle-orm';

import { auth } from './better-auth.instance';
import type { LoginDto } from './dto/login.dto';
import type { SignupDto } from './dto/signup.dto';

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  role: string;
  type: 'access';
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarColor: string | null;
  organization: { id: string; name: string };
}

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_BASE = {
  httpOnly: true,
  secure: serverEnv.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
} as const;

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  async signup(dto: SignupDto, ip?: string, userAgent?: string) {
    // 1. Use Better Auth to create the auth user (handles password hashing)
    let baResult: Awaited<ReturnType<typeof auth.api.signUpEmail>>;
    try {
      baResult = await auth.api.signUpEmail({
        body: {
          email: dto.email,
          name: dto.name,
          password: dto.password,
        },
        asResponse: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('unique')) {
        throw new ConflictException({
          error: { code: 'email_taken', message: 'האימייל כבר רשום' },
        });
      }
      throw err;
    }

    const baUserId = baResult.user.id;
    const orgId = randomUUID();
    const now = new Date();

    // 2. Bootstrap org + user + membership with BYPASSRLS (providerDb).
    // users RLS USING clause checks for membership existence — can't use withTenant
    // before the membership row exists (chicken-and-egg), so we bypass RLS here.
    await providerDb.transaction(async (tx) => {
      await tx.insert(organizations).values({
        id: orgId,
        name: dto.org_name,
        slug: orgId,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(users).values({
        id: baUserId,
        email: dto.email,
        name: dto.name,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(memberships).values({
        orgId,
        userId: baUserId,
        role: 'manager',
        isPrimary: true,
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    // 3. Audit log — membership now exists so withTenant is safe
    await withTenant(orgId, async (tx) => {
      const audit = new AuditService(tx);
      await audit.log({
        orgId,
        actorId: baUserId,
        actorType: 'user',
        action: 'org_created',
        targetTable: 'organizations',
        targetId: orgId,
        afterState: { org_name: dto.org_name, first_manager: baUserId },
        ip,
        userAgent,
      });
      await audit.log({
        orgId,
        actorId: baUserId,
        actorType: 'user',
        action: 'first_manager_created',
        targetTable: 'users',
        targetId: baUserId,
        ip,
        userAgent,
      });
    });

    // 4. Issue tokens
    const refreshToken = this.newRefreshToken(baUserId);
    const accessToken = this.signAccess({ sub: baUserId, orgId, role: 'manager' });

    return {
      accessToken,
      refreshToken,
      user: {
        id: baUserId,
        name: dto.name,
        email: dto.email,
        role: 'manager',
        organization: { id: orgId, name: dto.org_name },
      },
    };
  }

  async login(dto: LoginDto, ip?: string, userAgent?: string) {
    // 1. Verify credentials via Better Auth (handles timing-safe compare + hash)
    let baResult: Awaited<ReturnType<typeof auth.api.signInEmail>>;
    try {
      baResult = await auth.api.signInEmail({
        body: { email: dto.email, password: dto.password },
        asResponse: false,
      });
    } catch {
      throw new UnauthorizedException({
        error: { code: 'invalid_credentials', message: 'אימייל או סיסמה שגויים' },
      });
    }

    const baUserId = baResult.user.id;

    // 2. Load domain data — find user's active org (first active membership)
    const profile = await this.loadProfile(baUserId);
    if (!profile) {
      throw new UnauthorizedException({
        error: { code: 'no_org', message: 'לא נמצא ארגון משויך' },
      });
    }

    // 3. Write audit log
    await withTenant(profile.organization.id, async (tx) => {
      const audit = new AuditService(tx);
      await audit.log({
        orgId: profile.organization.id,
        actorId: baUserId,
        actorType: 'user',
        actorEmail: dto.email,
        action: 'login',
        ip,
        userAgent,
      });
    });

    // 4. Issue tokens
    const refreshToken = this.newRefreshToken(baUserId);
    const accessToken = this.signAccess({
      sub: baUserId,
      orgId: profile.organization.id,
      role: profile.role,
    });

    return { accessToken, refreshToken, user: profile };
  }

  async refresh(oldRefreshToken: string) {
    // 1. Look up the refresh token in ba_session
    const [session] = await db
      .select()
      .from(baSession)
      .where(and(eq(baSession.token, oldRefreshToken), gt(baSession.expiresAt, new Date())))
      .limit(1);

    if (!session) {
      throw new UnauthorizedException({
        error: { code: 'invalid_refresh', message: 'Session expired' },
      });
    }

    // 2. Load domain profile to get current role + org
    const profile = await this.loadProfile(session.userId);
    if (!profile) {
      throw new UnauthorizedException({ error: { code: 'no_org' } });
    }

    // 3. Rotate refresh token (delete old, insert new)
    const newRefreshToken = await this.rotateRefreshToken(oldRefreshToken, session.userId);

    // 4. Issue new access token
    const accessToken = this.signAccess({
      sub: session.userId,
      orgId: profile.organization.id,
      role: profile.role,
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string, userId: string, orgId: string) {
    // Revoke the ba_session (makes refresh token useless)
    await db
      .delete(baSession)
      .where(eq(baSession.token, refreshToken))
      .catch(() => null);

    await withTenant(orgId, async (tx) => {
      const audit = new AuditService(tx);
      await audit.log({ orgId, actorId: userId, actorType: 'user', action: 'logout' });
    });
  }

  async switchOrg(
    userId: string,
    newOrgId: string,
  ): Promise<{ accessToken: string; role: string }> {
    // Verify user is a member of the target org
    const [membership] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, newOrgId)))
      .limit(1);

    if (!membership) {
      throw new BadRequestException({ error: { code: 'not_member', message: 'לא חבר בארגון זה' } });
    }

    const accessToken = this.signAccess({ sub: userId, orgId: newOrgId, role: membership.role });
    return { accessToken, role: membership.role };
  }

  async getMe(userId: string): Promise<UserProfile | null> {
    return this.loadProfile(userId);
  }

  cookieOptions(ttlSec: number, path = '/') {
    return { ...COOKIE_BASE, maxAge: ttlSec, path };
  }

  clearCookieOptions() {
    return { ...COOKIE_BASE, maxAge: 0 };
  }

  private signAccess(payload: Omit<AccessTokenPayload, 'type'>): string {
    return this.jwt.sign({ ...payload, type: 'access' }, { expiresIn: ACCESS_TTL_SEC });
  }

  private newRefreshToken(userId: string): string {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    // Fire-and-forget insert (the session will be created asynchronously)
    db.insert(baSession)
      .values({
        id: randomUUID(),
        userId,
        token,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .catch((err: Error) => {
        process.stderr.write(`[auth] failed to persist refresh token: ${err.message}\n`);
      });
    return token;
  }

  private async rotateRefreshToken(oldToken: string, userId: string): Promise<string> {
    const newToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await db.transaction(async (tx) => {
      await tx.delete(baSession).where(eq(baSession.token, oldToken));
      await tx.insert(baSession).values({
        id: randomUUID(),
        userId,
        token: newToken,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    return newToken;
  }

  private async loadProfile(userId: string): Promise<UserProfile | null> {
    const [row] = await db
      .select({
        userId: users.id,
        userName: users.name,
        userEmail: users.email,
        avatarColor: users.avatarColor,
        role: memberships.role,
        orgId: organizations.id,
        orgName: organizations.name,
      })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(eq(users.id, userId)))
      .limit(1);

    if (!row) return null;

    return {
      id: row.userId,
      name: row.userName,
      email: row.userEmail,
      avatarColor: row.avatarColor,
      role: row.role,
      organization: { id: row.orgId, name: row.orgName },
    };
  }
}
