import { createHash, randomBytes } from 'node:crypto';

import {
  db,
  decryptField,
  env as dbEnv,
  hashField,
  providerAuditLog,
  providerSessions,
  providerUsers,
} from '@emapp/db';
import type { ProviderProfile } from '@emapp/shared-types';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

import { isDevBypassCode } from '../../../common/dev-auth-bypass';
import { dummyVerify, verifyPassword } from '../password';
import { flushSessionCache } from '../session-validity';

const ACCESS_TTL_SEC = 30 * 60; // Doc07 §6.7 — Provider access 30 min
const REFRESH_TTL_SEC = 4 * 60 * 60; // Doc07 §6.7 — Provider refresh 4 h
const JWT_ISS = 'emapp';
// Tier-isolated audience (audit-pass 2026-05-20 / D.29): distinct from
// 'emapp-api' (org) and 'emapp-tenant' (tenant). Tier confusion is now
// blocked STRUCTURALLY by JWT audience verification — not by a single
// payload.type check. MUST match provider-auth.guard.ts:audience.
const JWT_AUD = 'emapp-provider';
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

/**
 * The set of JWT role literals that the Provider tier accepts on
 * issuance + verification. Today: only `'provider_admin'`. Widening
 * (e.g. `'provider_viewer'`) is a Gate-6 / D.NN decision per D.37 —
 * adding a new literal here requires also adding it to:
 *   - PROVIDER_POLICY in apps/api/src/common/authz/policy.ts
 *   - ProviderAuthorizationGuard's canProvider call
 *   - ProviderAuthGuard's payload.role check
 *   - DB_TO_JWT_ROLE mapping below
 */
export type ProviderJwtRole = 'provider_admin';

/**
 * **Audit v1.1 SA-3 (HIGH) closure.** Pre-closure the JWT role was
 * literal `'provider_admin'` regardless of what `providerUsers.role`
 * contained — meaning the DB column was decorative and PR #41's new
 * `ProviderAuthorizationGuard` matrix was theoretical (an Ops attempt
 * to demote a user via SQL had zero runtime effect).
 *
 * Mapping is intentionally explicit: short DB values map to
 * tier-prefixed JWT values. Unknown DB values map to `null` and
 * cause login rejection — defence-in-depth against a corrupted /
 * typo'd column ("admn", "Admin", "manager").
 */
const DB_TO_JWT_ROLE: Record<string, ProviderJwtRole> = {
  admin: 'provider_admin',
  // Future widenings land HERE (and only here) once Gate-6 + D.NN approve:
  //   viewer: 'provider_viewer',
};

function mapProviderDbRole(dbRole: unknown): ProviderJwtRole | null {
  if (typeof dbRole !== 'string') return null;
  return DB_TO_JWT_ROLE[dbRole] ?? null;
}

export interface ProviderTokenPayload {
  sub: string;
  role: ProviderJwtRole;
  sid: string;
  type: 'provider_access';
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class ProviderAuthService {
  constructor(private readonly jwt: JwtService) {}

  // Single generic failure for EVERY rejection path (unknown / disabled /
  // bad password / bad MFA / locked) — never reveal which factor failed or
  // whether the account exists (Doc07 §6.12.1). MFA is mandatory: there is
  // no password-only success path.
  async login(
    dto: { email: string; password: string; mfa_code: string },
    ip?: string,
    userAgent?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const invalid = new UnauthorizedException({
      error: { code: 'invalid_credentials', message: 'אימייל, סיסמה או קוד אימות שגויים' },
    });

    const [p] = await db
      .select({
        id: providerUsers.id,
        // Audit v1.1 SA-3 — pull the role too so signAccess can sign
        // the LOADED value instead of a hardcoded literal.
        role: providerUsers.role,
        passwordHash: providerUsers.passwordHash,
        mfaSecretEncrypted: providerUsers.mfaSecretEncrypted,
        recoveryCodesHash: providerUsers.recoveryCodesHash,
        failed: providerUsers.failedLoginCount,
        lockedUntil: providerUsers.lockedUntil,
        disabledAt: providerUsers.disabledAt,
      })
      .from(providerUsers)
      .where(eq(providerUsers.email, dto.email))
      .limit(1);

    if (!p || p.disabledAt) {
      await dummyVerify(dto.password);
      throw invalid;
    }

    // Audit v1.1 SA-3 — reject unknown DB role values BEFORE checking
    // credentials. Keeps the failure indistinguishable from "wrong
    // password" (no oracle) while ensuring a corrupted column can
    // never mint a JWT. Done after dummyVerify(?) — no: do it AFTER
    // the password check to preserve timing parity. We use the same
    // generic `invalid` exception.
    const jwtRole = mapProviderDbRole(p.role);
    if (!jwtRole) {
      await dummyVerify(dto.password);
      throw invalid;
    }

    if (p.lockedUntil && p.lockedUntil.getTime() > Date.now()) {
      await dummyVerify(dto.password); // silent lock, timing parity
      throw invalid;
    }

    const passOk = await verifyPassword(p.passwordHash, dto.password);
    let mfaOk = false;
    let consumedRecovery: string[] | null = null;

    if (passOk) {
      const secret = await decryptField(
        db,
        p.mfaSecretEncrypted as Buffer,
        dbEnv.PII_ENCRYPTION_KEY as string,
      );
      const totp = new TOTP({ secret: Secret.fromBase32(secret), period: 30, digits: 6 });
      // ±1 step tolerance (Doc07 §6.6)
      mfaOk = totp.validate({ token: dto.mfa_code, window: 1 }) !== null;

      if (!mfaOk) {
        // Single-use recovery code path (8 hashed at enrolment).
        const codeHash = hashField(dto.mfa_code, dbEnv.PII_HASH_KEY as string);
        if (p.recoveryCodesHash.includes(codeHash)) {
          mfaOk = true;
          consumedRecovery = p.recoveryCodesHash.filter((h) => h !== codeHash);
        }
      }

      // Dev-only fixed MFA code (double-gated, prod-impossible — see
      // common/dev-auth-bypass.ts). Password is still required: we are inside
      // `if (passOk)`, so this bypasses ONLY the second factor, never the password.
      if (!mfaOk && isDevBypassCode(dto.mfa_code)) {
        mfaOk = true;
      }
    }

    if (!passOk || !mfaOk) {
      const failed = (p.failed ?? 0) + 1;
      const locked = failed >= MAX_FAILED;
      await db
        .update(providerUsers)
        .set({
          failedLoginCount: locked ? 0 : failed,
          lockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null,
        })
        .where(eq(providerUsers.id, p.id));
      throw invalid;
    }

    const rawRefresh = randomBytes(32).toString('hex');
    let sid = '';
    await db.transaction(async (tx) => {
      await tx
        .update(providerUsers)
        .set({
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          ...(consumedRecovery ? { recoveryCodesHash: consumedRecovery } : {}),
        })
        .where(eq(providerUsers.id, p.id));

      const [s] = await tx
        .insert(providerSessions)
        .values({
          providerUserId: p.id,
          tokenHash: sha256(rawRefresh),
          expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        })
        .returning({ id: providerSessions.id });
      sid = (s as { id: string }).id;

      await tx.insert(providerAuditLog).values({
        providerUserId: p.id,
        reason: 'provider login',
        actionType: 'login',
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        startedAt: new Date(),
      });
    });

    return { accessToken: this.signAccess(p.id, jwtRole, sid), refreshToken: rawRefresh };
  }

  async refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const expired = new UnauthorizedException({
      error: { code: 'invalid_refresh', message: 'Session expired' },
    });
    const [s] = await db
      .select({
        id: providerSessions.id,
        providerUserId: providerSessions.providerUserId,
        expiresAt: providerSessions.expiresAt,
        revokedAt: providerSessions.revokedAt,
        replacedBy: providerSessions.replacedBy,
      })
      .from(providerSessions)
      .where(eq(providerSessions.tokenHash, sha256(rawToken)))
      .limit(1);

    if (!s) throw expired;
    if (s.revokedAt) {
      if (s.replacedBy) {
        // Replay of a rotated token → purge the whole chain + audit.
        await db.transaction(async (tx) => {
          await tx
            .update(providerSessions)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(providerSessions.providerUserId, s.providerUserId),
                isNull(providerSessions.revokedAt),
              ),
            );
          await tx.insert(providerAuditLog).values({
            providerUserId: s.providerUserId,
            reason: 'provider refresh reuse detected',
            actionType: 'refresh_reuse_detected',
            startedAt: new Date(),
          });
        });
        flushSessionCache();
      }
      throw expired;
    }
    if (s.expiresAt.getTime() < Date.now()) throw expired;

    // Audit v1.1 SA-3 — refresh must also re-load the role from the
    // DB so a role change (Gate-6 widening / revocation) takes effect
    // on the next refresh window WITHOUT requiring the user to log
    // out and back in.
    const [refreshUser] = await db
      .select({ role: providerUsers.role })
      .from(providerUsers)
      .where(eq(providerUsers.id, s.providerUserId))
      .limit(1);
    const refreshJwtRole = mapProviderDbRole(refreshUser?.role);
    if (!refreshJwtRole) {
      // Corrupted / removed user → fail like an expired session
      // (no oracle distinguishing the cause).
      throw expired;
    }

    const rawNew = randomBytes(32).toString('hex');
    let newSid = '';
    await db.transaction(async (tx) => {
      const [s2] = await tx
        .insert(providerSessions)
        .values({
          providerUserId: s.providerUserId,
          tokenHash: sha256(rawNew),
          expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
        })
        .returning({ id: providerSessions.id });
      newSid = (s2 as { id: string }).id;
      const flipped = (await tx
        .update(providerSessions)
        .set({ revokedAt: new Date(), replacedBy: newSid })
        .where(and(eq(providerSessions.id, s.id), isNull(providerSessions.revokedAt)))
        .returning({ id: providerSessions.id })) as Array<{ id: string }>;
      if (flipped.length === 0) throw expired;
    });

    return {
      accessToken: this.signAccess(s.providerUserId, refreshJwtRole, newSid),
      refreshToken: rawNew,
    };
  }

  async logout(providerUserId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(providerSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(providerSessions.providerUserId, providerUserId),
            isNull(providerSessions.revokedAt),
          ),
        );
      await tx.insert(providerAuditLog).values({
        providerUserId,
        reason: 'provider logout',
        actionType: 'logout',
        startedAt: new Date(),
      });
    });
    flushSessionCache();
  }

  /**
   * **Audit v1.1 SA-3 (HIGH) closure.** Signs the JWT with the role
   * LOADED from the DB (mapped through DB_TO_JWT_ROLE) instead of a
   * hardcoded literal. Caller is responsible for already having
   * validated the role via `mapProviderDbRole` and rejected nulls
   * — this method assumes a valid role.
   */
  private signAccess(sub: string, role: ProviderJwtRole, sid: string): string {
    return this.jwt.sign(
      { sub, role, sid, type: 'provider_access' },
      { expiresIn: ACCESS_TTL_SEC, issuer: JWT_ISS, audience: JWT_AUD, algorithm: 'HS256' },
    );
  }

  /**
   * Self-identity lookup for the Provider tier — V10-S1 closure
   * (H1 Provider FE topology fix).
   *
   * Called by `ProviderMeController` on every page navigation through
   * the Provider FE subtree. The org-tier `/me` equivalent (auth.service
   * `getMe`) does the same lookup against `users + memberships`.
   *
   * **Performance** (runtime budget — Doc 03 §12):
   * - Single SELECT by primary key (provider_users.id); plan: index
   *   scan on pkey; ~sub-ms on a table that historically holds a handful
   *   of rows. No JOIN, no withProvider (no session opening, no audit
   *   row, no autonomous-tx ceremony — this is identity, not a
   *   cross-tenant action). Total path: ~JWT verify + 1 round-trip.
   * - No FE-side cache busting required; the FE wraps this in TanStack
   *   with `staleTime: 30_000` like every other read.
   *
   * **Security** (Doc 07 §7.10 + D.29 tier isolation + SA-3 + SA-5):
   * - Explicit per-column projection — never `select()` without args.
   *   `passwordHash`, `mfaSecretEncrypted`, `recoveryCodesHash`,
   *   `failedLoginCount`, `lockedUntil`, `lastLoginAt` are deliberately
   *   excluded. Adding them is a code-review-reject.
   * - Returns `null` for: missing row, disabled row (disabledAt set),
   *   corrupted role (DB value not in DB_TO_JWT_ROLE). Caller MUST map
   *   `null → 401 invalid_token` to preserve anti-enum invariant
   *   (Doc 07 §6.12.1) — same error shape as expired JWT, malformed
   *   JWT, wrong audience.
   * - No audit row written. The org-tier `/me` is unaudited for the
   *   same reason (called every page nav; identity is a metadata query,
   *   not a cross-tenant action). The privileged-tier `withProvider`
   *   audit obligation only applies to cross-tenant reads / actions
   *   (D.37) — not to self-identity. If an attacker probes `/me` with
   *   a stolen JWT, the auth path already audits the original login
   *   + every cross-tenant call they make afterwards; piling on /me
   *   would just add noise.
   *
   * Locked / failed_login state: this method intentionally does NOT
   * check `lockedUntil`. A locked account that somehow has an active
   * session token (lock fires only on login failure; a successful
   * login clears `lockedUntil`) means the user has already authenticated
   * past it — re-checking would be defense-in-depth that loses to
   * complexity. Subsequent cross-tenant calls re-validate via session
   * cache anyway.
   */
  async getProfile(providerUserId: string): Promise<ProviderProfile | null> {
    const [p] = await db
      .select({
        id: providerUsers.id,
        email: providerUsers.email,
        name: providerUsers.name,
        role: providerUsers.role,
        disabledAt: providerUsers.disabledAt,
      })
      .from(providerUsers)
      .where(eq(providerUsers.id, providerUserId))
      .limit(1);

    if (!p) return null;
    if (p.disabledAt) return null;
    const jwtRole = mapProviderDbRole(p.role);
    if (!jwtRole) return null;

    return {
      id: p.id,
      email: p.email,
      name: p.name,
      role: jwtRole,
    };
  }

  static readonly ACCESS_TTL_SEC = ACCESS_TTL_SEC;
  static readonly REFRESH_TTL_SEC = REFRESH_TTL_SEC;
}
