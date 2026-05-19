import { randomInt } from 'node:crypto';

import { db, env as dbEnv, hashField, type ISMSProvider, otpCodes, owners } from '@emapp/db';
import { normalizeIsraeliPhone } from '@emapp/validators';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

export const SMS_PROVIDER = 'SMS_PROVIDER';

const TTL_MS = 5 * 60 * 1000; // OTP valid 5 min (Doc 08 §4)
const MAX_ATTEMPTS = 5;
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 3; // 3 requests / 15 min / phone (GATE 4)
const TENANT_ACCESS_TTL_SEC = 30 * 60;
const JWT_ISS = 'emapp';
// Tier-isolated audience (audit-pass 2026-05-20 / D.29): distinct from
// 'emapp-api' (org) and 'emapp-provider' (provider). Tier confusion is
// now blocked STRUCTURALLY by JWT audience verification.
// MUST match tenant-auth.guard.ts:audience.
const JWT_AUD = 'emapp-tenant';

@Injectable()
export class OtpService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(SMS_PROVIDER) private readonly sms: ISMSProvider,
  ) {}

  // Always returns the SAME generic outcome — never reveals whether the
  // phone maps to an owner (anti-enumeration, D.14/Doc07 §6.12.1). SMS is
  // sent ONLY if the phone resolves to an owner; otherwise a silent no-op
  // with an identical response.
  async request(rawPhone: string): Promise<void> {
    const phone = normalizeIsraeliPhone(rawPhone);
    if (!phone) return; // invalid → generic no-op
    const phoneHash = hashField(phone, dbEnv.PII_HASH_KEY as string);

    // 3 / 15 min / phone — derived from created_at (no extra table).
    const rl = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.phoneHash, phoneHash),
          gt(otpCodes.createdAt, new Date(Date.now() - RL_WINDOW_MS)),
        ),
      )) as Array<{ n: number }>;
    if ((rl[0]?.n ?? 0) >= RL_MAX) return; // silently throttled — same generic response

    const [owner] = await db
      .select({ id: owners.id, orgId: owners.orgId })
      .from(owners)
      .where(eq(owners.phoneHash, phoneHash))
      .limit(1);
    if (!owner) return; // unknown phone → no SMS, identical response

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); // CSPRNG
    await db.insert(otpCodes).values({
      phoneHash,
      codeHash: hashField(code, dbEnv.PII_HASH_KEY as string),
      ownerId: owner.id,
      orgId: owner.orgId,
      expiresAt: new Date(Date.now() + TTL_MS),
    });
    await this.sms.send(phone, `EMAPP: קוד האימות שלך ${code}. תקף ל-5 דקות.`);
  }

  // Generic 401 on EVERY failure (unknown / expired / used / wrong code /
  // attempts exhausted) — no oracle. Success → short-lived tenant JWT
  // (own-record-only; resident re-verifies via SMS, no refresh token).
  async verify(rawPhone: string, code: string): Promise<{ accessToken: string }> {
    const invalid = new UnauthorizedException({
      error: { code: 'invalid_otp', message: 'קוד שגוי או שפג תוקפו' },
    });
    const phone = normalizeIsraeliPhone(rawPhone);
    if (!phone) throw invalid;
    const phoneHash = hashField(phone, dbEnv.PII_HASH_KEY as string);

    const [row] = await db
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.phoneHash, phoneHash), isNull(otpCodes.usedAt)))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);

    if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= MAX_ATTEMPTS) {
      throw invalid;
    }

    const attempts = row.attempts + 1;
    const ok = row.codeHash === hashField(code, dbEnv.PII_HASH_KEY as string);
    await db
      .update(otpCodes)
      .set({ attempts, usedAt: ok || attempts >= MAX_ATTEMPTS ? new Date() : null })
      .where(eq(otpCodes.id, row.id));
    if (!ok) throw invalid;

    const accessToken = this.jwt.sign(
      { sub: row.ownerId, orgId: row.orgId, role: 'tenant', type: 'tenant_access' },
      { expiresIn: TENANT_ACCESS_TTL_SEC, issuer: JWT_ISS, audience: JWT_AUD, algorithm: 'HS256' },
    );
    return { accessToken };
  }

  static readonly ACCESS_TTL_SEC = TENANT_ACCESS_TTL_SEC;
}
