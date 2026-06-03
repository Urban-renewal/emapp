import { randomBytes, randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  auditLog,
  authSessions,
  db,
  memberships,
  organizations,
  roleAssignments,
  roles,
  users,
  withBootstrap,
  withTenant,
} from '@emapp/db';
import type { AgentCapabilities } from '@emapp/shared-types';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import {
  PermissionResolutionCache,
  PermissionService,
} from '../../common/authz/permission.service';

import type { LoginDto } from './dto/login.dto';
import type { SignupDto } from './dto/signup.dto';
import { dummyVerify, hashPassword, verifyPassword } from './password';
import { flushSessionCache } from './session-validity';
import { createSession, findByRawToken, hashToken, newRawToken } from './session.repository';

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  role: string;
  sid: string;
  type: 'access';
  // Request-context, NOT JWT claims — never signed/verified. Populated by
  // the CurrentUser decorator from the trusted request (trustProxy) so
  // services can attach source IP / User-Agent to the audit trail
  // (ISO 27001 A.12.4). Optional: absent in non-HTTP / test contexts.
  ip?: string;
  userAgent?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarColor: string | null;
  // G1a-supporting (audit-pass IV): expose org slug so the FE's per-project
  // Tenant link (`/tenant/<slug>?...`) can be constructed without a second
  // call. Slug is already public (URL-safe org identifier); zero PII risk.
  organization: { id: string; name: string; slug: string };
  // D2-DEF-3 / D.54 — can this actor reveal owner PII (manager always ·
  // agent per `view_owner_pii` capability · viewer never). UX gate only;
  // the BE reveal endpoint is the authority. Optional/add-only; only the
  // `/me` (loadProfile) path populates it.
  view_owner_pii?: boolean;
  // IAM slice 4 — the actor's EXACT effective permission-set on the active
  // org scope, resolved live through `PermissionService` (the slice-2 engine:
  // covering `role_assignments` ⋈ `role_permissions`, implication closure
  // expanded). ADDITIVE / add-only: nothing GATES on this yet (the FE cutover
  // is slice 5); `policy.ts` + the guards stay the live enforcer. Only the
  // `/me` (loadProfile) path populates it. Same optional/add-only pattern as
  // `view_owner_pii`.
  permissions?: string[];
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
  orgSlug: string;
  capabilities: AgentCapabilities | null;
}

// organizations.slug CHECK (migration 0010): ^[a-z][a-z0-9-]*[a-z0-9]$
// — must start with a lowercase letter, end alphanumeric. A raw UUID slug
// fails ~62% of the time (UUIDs starting 0-9). Build a conformant, unique
// slug from the org name + a random suffix.
export function makeSlug(name: string): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!/^[a-z]/.test(base)) base = base ? `org-${base}` : 'org';
  base = base.replace(/-+/g, '-').replace(/-$/g, '');
  const suffix = randomBytes(6).toString('hex'); // 12 chars, [0-9a-f]
  return `${base}-${suffix}`;
}

function isEmailDuplicate(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 6; depth += 1) {
    const o = e as { message?: string; code?: string; constraint?: string; cause?: unknown };
    const msg = (o.message ?? '').toLowerCase();
    if (o.constraint === 'users_email_unique') return true;
    if (o.code === '23505' && msg.includes('users_email_unique')) return true;
    if (msg.includes('users_email_unique')) return true;
    e = o.cause;
  }
  return false;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly permissions: PermissionService,
  ) {}

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
    const slug = makeSlug(dto.org_name);

    // Anti-enumeration (D.14): if the email already exists we DO NOT reveal it
    // and DO NOT throw a distinguishable 409. The unique index makes the
    // insert fail; we map that single case to a neutral "accepted" outcome.
    try {
      const sessionId = await withBootstrap(async (tx) => {
        await tx
          .insert(organizations)
          .values({ id: orgId, name: dto.org_name, slug, createdAt: now, updatedAt: now });

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

        // IAM slice 5 — provision the org's authorization. The engine
        // (AuthorizationGuard ⋈ PermissionService) resolves permissions from
        // `role_assignments`; without a row the first user has ZERO permissions
        // and is locked out of their own org. Decision §11.1 / migration 0044:
        // the org's primary manager is the OWNER. We keep `memberships.role =
        // 'manager'` (the legacy field, unchanged) AND grant an org-scope OWNER
        // assignment so the engine resolves the full Owner set. Atomic with the
        // membership (same withBootstrap tx) — never an org with no admin.
        const [ownerRole] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(and(isNull(roles.orgId), eq(roles.isSystem, true), eq(roles.key, 'owner')))
          .limit(1);
        if (!ownerRole) throw new Error('signup: owner system role not found (seed missing)');
        await tx.insert(roleAssignments).values({
          userId,
          roleId: ownerRole.id,
          scopeType: 'org',
          scopeId: orgId,
          grantedBy: userId,
          grantedAt: now,
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
          {
            orgId,
            actorId: userId,
            actorType: 'user',
            action: 'role.grant',
            targetTable: 'role_assignments',
            targetId: userId,
            afterState: { role: 'owner', scope: 'org' }, // no PII
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
          organization: { id: orgId, name: dto.org_name, slug },
        },
      };
    } catch (err: unknown) {
      // ONLY the email unique index means "email already registered". Drizzle
      // wraps the pg error, so the constraint name lives on err.cause — walk
      // the chain. A slug clash (different constraint) must NOT be misread as
      // duplicate-email; it surfaces as a real error.
      if (isEmailDuplicate(err)) {
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

    // Single round-trip: auth fields + the active primary org in one JOIN
    // (was two sequential SELECTs on the hottest path). LEFT JOINs so a user
    // with no active membership still returns one row (orgId null) — needed
    // to run real argon2 + lockout without leaking existence.
    const [u] = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        failed: users.failedLoginCount,
        lockedUntil: users.lockedUntil,
        archivedAt: users.archivedAt,
        userName: users.name,
        userEmail: users.email,
        avatarColor: users.avatarColor,
        role: memberships.role,
        orgId: organizations.id,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        // D.49 — operational suspension state. NOT filtered in the JOIN (a
        // suspended org must still resolve, so we can return the specific
        // `org_suspended` code for a valid member rather than a generic
        // invalid-creds). archivedAt stays a JOIN filter (archived = gone).
        orgSuspendedAt: organizations.suspendedAt,
      })
      .from(users)
      .leftJoin(memberships, and(eq(memberships.userId, users.id), isNull(memberships.revokedAt)))
      .leftJoin(
        organizations,
        and(eq(organizations.id, memberships.orgId), isNull(organizations.archivedAt)),
      )
      .where(eq(users.email, dto.email))
      .orderBy(desc(memberships.isPrimary), asc(memberships.createdAt))
      .limit(1);

    if (!u || !u.passwordHash || u.archivedAt) {
      await dummyVerify(dto.password); // constant-time: no user-existence oracle
      throw invalid;
    }

    const isLocked = !!(u.lockedUntil && u.lockedUntil.getTime() > Date.now());
    if (isLocked) {
      // SILENT lockout (anti-enumeration, Doc07 §6.12.1): a locked account
      // returns the SAME generic 401 as wrong-password / unknown-user — never
      // a distinct 423/"account_locked", which would confirm the email
      // exists. We still pay the argon2 cost for timing parity, then bail.
      await dummyVerify(dto.password);
      // G1b (audit-pass IV) — docs/07 §12.2 mandates "Login success/failure".
      // We have a real user + org context here (lockout requires a known
      // user; the JOIN supplies the primary org); audit it. The user-facing
      // response is still generic — no anti-enumeration regression.
      if (u.orgId) {
        await this.writeLoginAuditSafe({
          orgId: u.orgId,
          actorId: u.id,
          actorEmail: dto.email,
          action: 'auth.login_failed',
          afterState: { reason: 'locked' },
          ip,
          userAgent,
        });
      }
      throw invalid;
    }

    const ok = await verifyPassword(u.passwordHash, dto.password);
    if (!ok) {
      // Spec Doc07 §6.11: 5 failures / 15 min → flat 15-min lock (NOT
      // exponential — that turned a known email into an indefinite DoS).
      // A stale (expired) lock resets the window so it's exactly 5 per
      // 15-min window, and the lock auto-clears after 15 min.
      const staleWindow = u.lockedUntil != null && u.lockedUntil.getTime() <= Date.now();
      const failed = (staleWindow ? 0 : (u.failed ?? 0)) + 1;
      const locked = failed >= MAX_FAILED;
      await db
        .update(users)
        .set({
          failedLoginCount: locked ? 0 : failed,
          lockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null,
        })
        .where(eq(users.id, u.id));
      // G1b — wrong-password audit. Records whether THIS attempt triggered
      // the lock (a separate state transition worth distinguishing in the
      // audit trail for brute-force detection).
      if (u.orgId) {
        await this.writeLoginAuditSafe({
          orgId: u.orgId,
          actorId: u.id,
          actorEmail: dto.email,
          action: 'auth.login_failed',
          afterState: { reason: 'wrong_password', attempts: failed, lockedNow: locked },
          ip,
          userAgent,
        });
      }
      throw invalid;
    }

    // No active org → indistinguishable from bad creds (anti-enumeration).
    if (!u.orgId || !u.role || !u.orgName) throw invalid;

    // D.49 — the org is operationally SUSPENDED. We only reach here AFTER the
    // password is verified and an active membership is confirmed, so the user
    // has already proved they belong: returning a distinct, actionable code is
    // NOT an enumeration oracle (unlike archived/no-org, which stay generic).
    // No session is issued; the blocked attempt is audited.
    if (u.orgSuspendedAt) {
      await this.writeLoginAuditSafe({
        orgId: u.orgId,
        actorId: u.id,
        actorEmail: dto.email,
        action: 'auth.login_failed',
        afterState: { reason: 'org_suspended' },
        ip,
        userAgent,
      });
      throw new UnauthorizedException({
        error: { code: 'org_suspended', message: 'הארגון מושעה. לפרטים פנו לתמיכה.' },
      });
    }

    const profile: UserProfile = {
      id: u.id,
      name: u.userName,
      email: u.userEmail,
      role: u.role,
      avatarColor: u.avatarColor,
      organization: { id: u.orgId, name: u.orgName, slug: u.orgSlug ?? '' },
    };

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
        flushSessionCache(); // immediate access-token kill on theft signal
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
    flushSessionCache(); // access token stops working immediately on logout
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
        orgSlug: organizations.slug,
        capabilities: memberships.capabilities,
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
    // D2-DEF-3 / D.54 — manager always reveals; agent iff the capability is
    // granted; viewer never. Mirrors the BE reveal gate
    // (`resolveOwnerPiiFidelity`) so the FE button visibility matches the
    // server's authoritative decision.
    const viewOwnerPii =
      row.role === 'manager'
        ? true
        : row.role === 'agent'
          ? Boolean(row.capabilities?.view_owner_pii)
          : false;

    // IAM slice 4 — the actor's effective permission-set on the active org
    // scope, resolved live through the slice-2 engine. ONE resolve (a fresh
    // per-request cache, a single `resolveAssignments` query inside one
    // `withTenant` — RLS-scoped to this org). ADDITIVE: this is computed and
    // returned, but NOTHING gates on it (the FE cutover is slice 5); `policy.ts`
    // + the guards remain the live enforcer. Failure to resolve must never
    // break `/me` — degrade to an empty set (the FE treats absent/empty as
    // "no extra grants", the safe default, exactly like `view_owner_pii`).
    const permissions = await this.resolveEffectivePermissions(row.userId, row.orgId);

    return {
      id: row.userId,
      name: row.userName,
      email: row.userEmail,
      avatarColor: row.avatarColor,
      role: row.role,
      organization: { id: row.orgId, name: row.orgName, slug: row.orgSlug },
      view_owner_pii: viewOwnerPii,
      permissions,
    };
  }

  // IAM slice 4 — resolve the user's effective permissions on the org scope
  // via the slice-2 `PermissionService` engine. One `withTenant` (RLS-scoped),
  // one fresh `PermissionResolutionCache` ⇒ exactly one resolve query
  // (≤3 round-trips: BEGIN/SET-ROLE, SET-config, the resolve SELECT). Sorted
  // for a stable, deterministic `/me` payload. Best-effort: any error degrades
  // to an empty set so `/me` stays available (additive, non-gating field).
  private async resolveEffectivePermissions(userId: string, orgId: string): Promise<string[]> {
    try {
      const effective = await withTenant(orgId, async (tx) => {
        const cache = new PermissionResolutionCache();
        return this.permissions.effectivePermissions(
          { id: userId, orgId },
          { type: 'org', id: orgId },
          tx,
          cache,
        );
      });
      return [...effective].sort();
    } catch {
      return [];
    }
  }

  // G1b helper — best-effort audit_log write for login failure events.
  // Best-effort: an audit hiccup must never escalate to a 500 on the
  // auth flow itself. Uses the BYPASSRLS pool with an explicit org_id
  // because the login flow has no app.organization_id context yet.
  private async writeLoginAuditSafe(entry: {
    orgId: string;
    actorId: string;
    actorEmail: string;
    action: string;
    afterState?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    try {
      await db.insert(auditLog).values({
        orgId: entry.orgId,
        actorId: entry.actorId,
        actorType: 'user',
        actorEmail: entry.actorEmail,
        action: entry.action,
        afterState: entry.afterState,
        ip: entry.ip,
        userAgent: entry.userAgent,
      });
    } catch {
      // best-effort; never surface to the user.
    }
  }
}
