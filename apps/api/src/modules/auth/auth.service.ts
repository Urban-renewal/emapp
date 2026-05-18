import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  auditLog,
  authSessions,
  db,
  memberships,
  organizations,
  providerDb,
  users,
} from '@emapp/db';
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import type { LoginDto } from './dto/login.dto';
import type { SignupDto } from './dto/signup.dto';
import { dummyVerify, hashPassword, verifyPassword } from './password';
import { createSession, findByRawToken, hashToken, newRawToken } from './session.repository';

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  role: string;
  sid: string;
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
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
const JWT_ISS = 'emapp';
const JWT_AUD = 'emapp-api';
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

// Secure cookies everywhere except local dev/test (http://localhost). Prod
// and any non-dev/test deploy get Secure (closes the "staging not secure" gap).
const SECURE = serverEnv.NODE_ENV !== 'development' && serverEnv.NODE_ENV !== 'test';
const COOKIE_BASE = { httpOnly: true, secure: SECURE, sameSite: 'lax' as const } as const;
const REFRESH_PATH = '/api/v1/auth/refresh';

interface ProfileRow {
  userId: string;
  userName: string;
  userEmail: string;
  avatarColor: string | null;
  role: string;
  orgId: string;
  orgName: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  // ── signup: ONE atomic transaction (D.21). org+user+membership+credential
  // +audit+session either all commit or all roll back. No second store, so
  // an orphaned auth identity is structurally impossible.
  async signup(
    dto: SignupDto,
    ip?: string,
    userAgent?: string,
  ): Promise<
    { accessToken: string; refreshToken: string; user: UserProfile } | { duplicate: true }
  > {
    const passwordHash = await hashPassword(dto.password);
    const orgId = randomUUID();
    const userId = randomUUID();
    const now = new Date();
    const rawRefresh = newRawToken();

    // Anti-enumeration (D.14): if the email already exists we DO NOT reveal it
    // and DO NOT throw a distinguishable 409. The unique index makes the
    // insert fail; we map that single case to a neutral "accepted" outcome.
    try {
      const sessionId = await providerDb.transaction(async (tx) => {
        await tx
          .insert(organizations)
          .values({ id: orgId, name: dto.org_name, slug: orgId, createdAt: now, updatedAt: now });

        await tx.insert(users).values({
          id: userId,
          email: dto.email,
          name: dto.name,
          passwordHash,
          createdAt: now,
          updatedAt: now,
        });

        await tx.insert(memberships).values({
          userId,
          orgId,
          role: 'manager',
          isPrimary: true,
          acceptedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        const [s] = await tx
          .insert(authSessions)
          .values({
            userId,
            tokenHash: hashToken(rawRefresh),
            expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
            ip: ip ?? null,
            userAgent: userAgent ?? null,
          })
          .returning();

        await tx.insert(auditLog).values([
          {
            orgId,
            actorId: userId,
            actorType: 'user',
            action: 'org_created',
            targetTable: 'organizations',
            targetId: orgId,
            afterState: { org_name: dto.org_name },
            ip: ip ?? null,
            userAgent: userAgent ?? null,
          },
          {
            orgId,
            actorId: userId,
            actorType: 'user',
            action: 'first_manager_created',
            targetTable: 'users',
            targetId: userId,
            ip: ip ?? null,
            userAgent: userAgent ?? null,
          },
        ]);

        return (s as { id: string }).id;
      });

      const accessToken = this.signAccess({ sub: userId, orgId, role: 'manager', sid: sessionId });
      return {
        accessToken,
        refreshToken: rawRefresh,
        user: {
          id: userId,
          name: dto.name,
          email: dto.email,
          role: 'manager',
          avatarColor: null,
          organization: { id: orgId, name: dto.org_name },
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (msg.includes('users_email_unique') || msg.includes('duplicate key')) {
        // Neutral outcome — caller returns a generic accepted response.
        return { duplicate: true };
      }
      throw err;
    }
  }

  async login(
    dto: LoginDto,
    ip?: string,
    userAgent?: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: UserProfile }> {
    const invalid = new UnauthorizedException({
      error: { code: 'invalid_credentials', message: 'אימייל או סיסמה שגויים' },
    });

    const [u] = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        failed: users.failedLoginCount,
        lockedUntil: users.lockedUntil,
        archivedAt: users.archivedAt,
      })
      .from(users)
      .where(eq(users.email, dto.email))
      .limit(1);

    if (!u || !u.passwordHash || u.archivedAt) {
      await dummyVerify(dto.password); // constant-time: no user-existence oracle
      throw invalid;
    }

    if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) {
      // 423 Locked — distinct from 401 so clients/monitoring see lockout.
      throw new HttpException(
        { error: { code: 'account_locked', message: 'החשבון נעול זמנית' } },
        423,
      );
    }

    const ok = await verifyPassword(u.passwordHash, dto.password);
    if (!ok) {
      const failed = (u.failed ?? 0) + 1;
      const locked = failed >= MAX_FAILED;
      await db
        .update(users)
        .set({
          failedLoginCount: locked ? 0 : failed,
          lockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null,
        })
        .where(eq(users.id, u.id));
      throw invalid;
    }

    const profile = await this.loadProfile(u.id);
    if (!profile) throw invalid; // no active org → indistinguishable from bad creds

    const rawRefresh = newRawToken();
    let sid = '';
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, u.id));
      sid = await createSession(tx as never, u.id, rawRefresh, ip, userAgent);
      await tx.insert(auditLog).values({
        orgId: profile.organization.id,
        actorId: u.id,
        actorType: 'user',
        actorEmail: dto.email,
        action: 'login',
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    });

    const accessToken = this.signAccess({
      sub: u.id,
      orgId: profile.organization.id,
      role: profile.role,
      sid,
    });
    return { accessToken, refreshToken: rawRefresh, user: profile };
  }

  // Rotation + reuse-detection. Replaying a rotated token = theft signal →
  // revoke the whole chain for that user + audit.
  async refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const expired = new UnauthorizedException({
      error: { code: 'invalid_refresh', message: 'Session expired' },
    });

    const s = await findByRawToken(db, rawToken);
    if (!s) throw expired;

    if (s.revokedAt) {
      if (s.replacedBy) {
        // Reuse of an already-rotated token → purge all sessions + audit.
        const profile = await this.loadProfile(s.userId);
        await db.transaction(async (tx) => {
          await tx
            .update(authSessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(authSessions.userId, s.userId), isNull(authSessions.revokedAt)));
          if (profile) {
            await tx.insert(auditLog).values({
              orgId: profile.organization.id,
              actorId: s.userId,
              actorType: 'user',
              action: 'refresh_reuse_detected',
              ip: null,
              userAgent: null,
            });
          }
        });
      }
      throw expired;
    }

    if (s.expiresAt.getTime() < Date.now()) throw expired;

    const profile = await this.loadProfile(s.userId);
    if (!profile) throw expired;

    const rawNew = newRawToken();
    let newSid = '';
    await db.transaction(async (tx) => {
      newSid = await createSession(tx as never, s.userId, rawNew);
      // Conditional flip closes the rotation TOCTOU: only the request that
      // actually moves revoked_at NULL→now wins. A concurrent double-spend
      // of the same token flips 0 rows here → we abort that branch.
      const flipped = (await tx
        .update(authSessions)
        .set({ revokedAt: new Date(), replacedBy: newSid })
        .where(and(eq(authSessions.id, s.id), isNull(authSessions.revokedAt)))
        .returning({ id: authSessions.id })) as Array<{ id: string }>;
      if (flipped.length === 0) {
        throw expired;
      }
    });

    const accessToken = this.signAccess({
      sub: s.userId,
      orgId: profile.organization.id,
      role: profile.role,
      sid: newSid,
    });
    return { accessToken, refreshToken: rawNew };
  }

  // Logout is authenticated, so we revoke EVERY active session for the user
  // (robust: the path-scoped refresh cookie is not sent to /logout, and a
  // full revoke is the safer behaviour anyway).
  async logout(userId: string, orgId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
      await tx.insert(auditLog).values({
        orgId,
        actorId: userId,
        actorType: 'user',
        action: 'logout',
      });
    });
  }

  async switchOrg(
    userId: string,
    newOrgId: string,
    sid: string,
  ): Promise<{ accessToken: string; role: string }> {
    const [m] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.orgId, newOrgId),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);

    if (!m) {
      throw new UnauthorizedException({
        error: { code: 'not_member', message: 'לא חבר בארגון זה' },
      });
    }

    // Audit the authorization change (security-relevant).
    await db.insert(auditLog).values({
      orgId: newOrgId,
      actorId: userId,
      actorType: 'user',
      action: 'org_switched',
      targetTable: 'organizations',
      targetId: newOrgId,
    });

    // The session id is preserved (same refresh chain) — only the active org
    // claim changes. A fresh access token bound to the new org is required;
    // the old one stays bound to its old org (cannot reach the new one).
    const accessToken = this.signAccess({ sub: userId, orgId: newOrgId, role: m.role, sid });
    return { accessToken, role: m.role };
  }

  async getMe(userId: string): Promise<UserProfile | null> {
    return this.loadProfile(userId);
  }

  cookies(accessToken: string, refreshToken: string) {
    return {
      access: {
        name: 'access_token',
        value: accessToken,
        opts: { ...COOKIE_BASE, path: '/', maxAge: ACCESS_TTL_SEC },
      },
      refresh: {
        name: 'refresh_token',
        value: refreshToken,
        opts: { ...COOKIE_BASE, path: REFRESH_PATH, maxAge: REFRESH_TTL_SEC },
      },
    };
  }

  clearCookieOpts(path = '/') {
    return { ...COOKIE_BASE, path, maxAge: 0 };
  }

  private signAccess(p: Omit<AccessTokenPayload, 'type'>): string {
    return this.jwt.sign(
      { ...p, type: 'access' },
      { expiresIn: ACCESS_TTL_SEC, issuer: JWT_ISS, audience: JWT_AUD, algorithm: 'HS256' },
    );
  }

  // Active membership only (revoked_at IS NULL), non-archived user, primary
  // org first then oldest — deterministic, no privilege/offboarding bypass.
  private async loadProfile(userId: string): Promise<UserProfile | null> {
    const [row] = (await db
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
      .where(
        and(
          eq(users.id, userId),
          isNull(users.archivedAt),
          isNull(memberships.revokedAt),
          isNull(organizations.archivedAt),
        ),
      )
      .orderBy(desc(memberships.isPrimary), asc(memberships.createdAt))
      .limit(1)) as ProfileRow[];

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
