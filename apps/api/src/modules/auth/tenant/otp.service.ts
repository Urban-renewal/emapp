import { randomInt } from 'node:crypto';

import {
  auditLog,
  db,
  env as dbEnv,
  hashField,
  type ISMSProvider,
  organizations,
  otpCodes,
  owners,
} from '@emapp/db';
import { normalizeIsraeliPhone } from '@emapp/validators';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

export const SMS_PROVIDER = 'SMS_PROVIDER';

/** G1a (audit-pass IV): per-request forensic context — IP + UA — passed
 * through from the controller for the audit_log row. Optional everywhere
 * so callers without HTTP context (tests) don't break. */
export interface AuthCtx {
  ip?: string;
  userAgent?: string;
}

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
  // sent ONLY if the phone resolves to a UNIQUE owner; otherwise a silent
  // no-op with an identical response.
  //
  // F2 (audit-pass III, D.30) — multi-org phone disambiguation. The
  // owners table is org-scoped; the same phone can be a legitimate owner
  // in multiple orgs (docs/01 §5.3 — resident with apartments in
  // different developers' projects). Historical code did
  // `WHERE phoneHash=X LIMIT 1` against the BYPASSRLS pool → arbitrary
  // owner picked → Tenant token issued for the WRONG org. Now:
  //   * `org_slug` supplied → filter by (phoneHash AND orgs.slug); if
  //     no match → silent no-op (anti-enum).
  //   * `org_slug` absent → count owners by phoneHash; only send SMS if
  //     EXACTLY ONE matches. 0 or ≥2 → silent no-op (caller must use
  //     the slug to disambiguate; matches the spec's "the WhatsApp link
  //     is per-project" model, so the FE always has the slug).
  async request(rawPhone: string, orgSlug?: string, ctx?: AuthCtx): Promise<void> {
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

    // F2 disambiguation — see comment above.
    let matched: { id: string; orgId: string } | undefined;
    if (orgSlug) {
      const [m] = await db
        .select({ id: owners.id, orgId: owners.orgId })
        .from(owners)
        .innerJoin(organizations, eq(organizations.id, owners.orgId))
        .where(and(eq(owners.phoneHash, phoneHash), eq(organizations.slug, orgSlug)))
        .limit(1);
      matched = m;
    } else {
      // LIMIT 2 is sufficient to distinguish "exactly 1" from "≥2".
      const rows = await db
        .select({ id: owners.id, orgId: owners.orgId })
        .from(owners)
        .where(eq(owners.phoneHash, phoneHash))
        .limit(2);
      if (rows.length === 1) matched = rows[0];
    }
    if (!matched) return; // unknown / ambiguous → no SMS, identical response

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); // CSPRNG
    await db.insert(otpCodes).values({
      phoneHash,
      codeHash: hashField(code, dbEnv.PII_HASH_KEY as string),
      ownerId: matched.id,
      orgId: matched.orgId,
      expiresAt: new Date(Date.now() + TTL_MS),
    });
    // G1a (audit-pass IV) — docs/07 §6.5 + §12.2 + docs/08 §4d require
    // every OTP send to be audited with IP+timestamp. We have a real org
    // context now (matched.orgId); use the BYPASSRLS pool to write the
    // row with that explicit org_id. actor_id is NULL because Tenant
    // identity lives in `owners` (not `users` — FK forbids it) — we use
    // target_table='owners' + target_id=matched.id to record WHICH owner
    // the OTP was sent for. Anti-enumeration preserved: this path runs
    // ONLY when an owner was found; unknown-phone / multi-org-without-
    // slug paths return without any audit (caller can't tell).
    await this.writeAuditSafe({
      orgId: matched.orgId,
      action: 'auth.otp_requested',
      targetTable: 'owners',
      targetId: matched.id,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
    });
    await this.sms.send(phone, `EMAPP: קוד האימות שלך ${code}. תקף ל-5 דקות.`);
  }

  // Generic 401 on EVERY failure (unknown / expired / used / wrong code /
  // attempts exhausted) — no oracle. Success → short-lived tenant JWT
  // (own-record-only; resident re-verifies via SMS, no refresh token).
  async verify(rawPhone: string, code: string, ctx?: AuthCtx): Promise<{ accessToken: string }> {
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
      // G1a: failure path. We CAN audit when a row exists with full org
      // context (we always set both on insert; the null-narrowing is to
      // satisfy the optional column types); pure-no-row stays silent
      // (anti-enumeration — no org context anyway).
      if (row?.orgId && row.ownerId) {
        await this.writeAuditSafe({
          orgId: row.orgId,
          action: 'auth.tenant_login_failed',
          targetTable: 'owners',
          targetId: row.ownerId,
          afterState: {
            reason: row.attempts >= MAX_ATTEMPTS ? 'attempts_exhausted' : 'expired',
          },
          ip: ctx?.ip,
          userAgent: ctx?.userAgent,
        });
      }
      throw invalid;
    }

    const attempts = row.attempts + 1;
    const ok = row.codeHash === hashField(code, dbEnv.PII_HASH_KEY as string);
    await db
      .update(otpCodes)
      .set({ attempts, usedAt: ok || attempts >= MAX_ATTEMPTS ? new Date() : null })
      .where(eq(otpCodes.id, row.id));
    if (!ok) {
      // G1a: wrong-code failure audit. row.orgId+ownerId always set on insert.
      if (row.orgId && row.ownerId) {
        await this.writeAuditSafe({
          orgId: row.orgId,
          action: 'auth.tenant_login_failed',
          targetTable: 'owners',
          targetId: row.ownerId,
          afterState: { reason: 'wrong_code', attempts },
          ip: ctx?.ip,
          userAgent: ctx?.userAgent,
        });
      }
      throw invalid;
    }

    const accessToken = this.jwt.sign(
      { sub: row.ownerId, orgId: row.orgId, role: 'tenant', type: 'tenant_access' },
      { expiresIn: TENANT_ACCESS_TTL_SEC, issuer: JWT_ISS, audience: JWT_AUD, algorithm: 'HS256' },
    );
    // G1a: success audit. Tenant identity = owner row (not users) → actor_id
    // stays NULL (FK forbids), tenant identified via target_table='owners'.
    if (row.orgId && row.ownerId) {
      await this.writeAuditSafe({
        orgId: row.orgId,
        action: 'auth.tenant_login',
        targetTable: 'owners',
        targetId: row.ownerId,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    }
    return { accessToken };
  }

  // G1a helper — best-effort audit write that NEVER breaks the auth flow
  // if it itself fails (the user must not get a 500 because audit hiccupped).
  // Uses the BYPASSRLS pool with explicit org_id because the OTP flow has
  // no app.organization_id context (pre-auth).
  private async writeAuditSafe(entry: {
    orgId: string;
    action: string;
    targetTable?: string;
    targetId?: string;
    afterState?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    try {
      // Drizzle accepts `undefined` for nullable columns; `null` collides
      // with the inferred types for some text/jsonb columns. Behaviour
      // identical (omitted columns → NULL in the row).
      await db.insert(auditLog).values({
        orgId: entry.orgId,
        // actorType: 'system' — required by CHECK constraint
        // `audit_log_actor_type_valid` (migration 0014) which limits the
        // discriminator to ('user','system','provider'); matches the
        // spec docs/07 §12.4. The Tenant identity is recorded via
        // target_table='owners' + target_id=ownerId, not via actor_id
        // (FK to users.id forbids it). A future 'tenant' actor_type
        // would require a Gate-2 migration to widen the CHECK.
        actorType: 'system',
        action: entry.action,
        targetTable: entry.targetTable,
        targetId: entry.targetId,
        afterState: entry.afterState,
        ip: entry.ip,
        userAgent: entry.userAgent,
      });
    } catch {
      // Best-effort: an audit-write failure must not surface to the user.
      // Server-side observability would catch it via process error logs.
    }
  }

  static readonly ACCESS_TTL_SEC = TENANT_ACCESS_TTL_SEC;
}
