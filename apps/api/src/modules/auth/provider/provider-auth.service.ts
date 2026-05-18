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
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

import { dummyVerify, verifyPassword } from '../password';

const ACCESS_TTL_SEC = 30 * 60; // Doc07 §6.7 — Provider access 30 min
const REFRESH_TTL_SEC = 4 * 60 * 60; // Doc07 §6.7 — Provider refresh 4 h
const JWT_ISS = 'emapp';
const JWT_AUD = 'emapp-api';
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

export interface ProviderTokenPayload {
  sub: string;
  role: 'provider_admin';
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

    return { accessToken: this.signAccess(p.id, sid), refreshToken: rawRefresh };
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
      }
      throw expired;
    }
    if (s.expiresAt.getTime() < Date.now()) throw expired;

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

    return { accessToken: this.signAccess(s.providerUserId, newSid), refreshToken: rawNew };
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
  }

  private signAccess(sub: string, sid: string): string {
    return this.jwt.sign(
      { sub, role: 'provider_admin', sid, type: 'provider_access' },
      { expiresIn: ACCESS_TTL_SEC, issuer: JWT_ISS, audience: JWT_AUD, algorithm: 'HS256' },
    );
  }

  static readonly ACCESS_TTL_SEC = ACCESS_TTL_SEC;
  static readonly REFRESH_TTL_SEC = REFRESH_TTL_SEC;
}
