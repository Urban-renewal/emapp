import { randomInt } from 'node:crypto';

import {
  auditLog,
  authSessions,
  db,
  env as dbEnv,
  hashField,
  stepUpCodes,
  users,
  type IEmailProvider,
} from '@emapp/db';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { EMAIL_PROVIDER } from '../members/invite-email';

import type { AccessTokenPayload } from './auth.service';

/** Mirrors the tenant OTP core (otp.service.ts): 5-min single-use code,
 * max-5 verify attempts, 3 requests / 15 min. The step-up variant delivers
 * via EMAIL (org users have a verified email, not a phone) and is bound to
 * the CALLER'S CURRENT session (user.sid) — verify stamps ONLY that
 * session's auth_sessions.pii_unlocked_at (D-P5.5, once-per-SESSION). */
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 3; // 3 requests / 15 min / user — the 4th sends NO email

/** The audit action the FE/forensics key on (pinned by the 7b-OTP spec). */
export const PII_UNLOCK_AUDIT_ACTION = 'session.pii_unlocked';

/** 7c — NODE_ENV values allowed to expose the step-up code (mirrors the
 * EXPOSE_INVITE_TOKEN L-3 hardening, members/invite-email.ts): ONLY
 * 'development' | 'test'. Anything else — unset, 'production', 'staging',
 * a typo like 'prod' — stays CLOSED. The allowlist itself may be a module
 * const (NODE_ENV is process-stable); the opt-in flag below is not. */
const STEP_UP_CODE_ENV_ALLOWLIST = new Set(['development', 'test']);

/**
 * 7c — dev/QA exposure of the step-up OTP code in the request() RESULT
 * (mirrors EXPOSE_INVITE_TOKEN exactly): IFF EXPOSE_STEP_UP_CODE === 'true'
 * AND NODE_ENV is in the strict allowlist. FAIL-CLOSED everywhere else —
 * the email is the canonical delivery channel.
 *
 * READ AT REQUEST TIME (not frozen into a module const) so QA can toggle
 * the env flag without restarting/touching module state.
 */
function exposeStepUpCode(): boolean {
  return (
    process.env['EXPOSE_STEP_UP_CODE'] === 'true' &&
    STEP_UP_CODE_ENV_ALLOWLIST.has(process.env['NODE_ENV'] ?? '')
  );
}

@Injectable()
export class StepUpService {
  private readonly logger = new Logger(StepUpService.name);

  constructor(@Inject(EMAIL_PROVIDER) private readonly email: IEmailProvider) {}

  /**
   * Request a PII step-up OTP for the caller's CURRENT session.
   *
   * Security posture (copied from the tenant OTP core):
   *  - CSPRNG 6-digit code; ONLY hashField(code) is stored — never plaintext.
   *  - Rate-limited 3/15min per user, derived from created_at (the 4th
   *    in-window request is a SILENT no-op — no email, no oracle).
   *  - The code is bound to (user, session): a stolen code cannot unlock a
   *    different session.
   *  - The code itself is NEVER logged. It is NEVER returned in production:
   *    the ONLY exception is the dev/QA exposure (7c) — { code } in the
   *    result IFF exposeStepUpCode() (EXPOSE_STEP_UP_CODE === 'true' AND
   *    NODE_ENV in the strict development|test allowlist, read at request
   *    time). Fail-closed otherwise — the result is {}.
   */
  async request(user: AccessTokenPayload): Promise<{ code?: string }> {
    const invalid = new UnauthorizedException({
      error: { code: 'invalid_session', message: 'נדרשת התחברות מחדש' },
    });

    // The unlock is a property of a LIVE domain session — a ghost/revoked/
    // expired sid gets nothing (and no email is burned on it).
    const [session] = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.id, user.sid),
          eq(authSessions.userId, user.sub),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!session) throw invalid;

    // 3 / 15 min / user — derived from created_at (no extra table; mirrors
    // the tenant OTP rate limit). Silently throttled: NO email, same outcome.
    const rl = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(stepUpCodes)
      .where(
        and(
          eq(stepUpCodes.userId, user.sub),
          gt(stepUpCodes.createdAt, new Date(Date.now() - RL_WINDOW_MS)),
        ),
      )) as Array<{ n: number }>;
    if ((rl[0]?.n ?? 0) >= RL_MAX) return {};

    const [recipient] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, user.sub))
      .limit(1);
    if (!recipient) throw invalid;

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); // CSPRNG
    await db.insert(stepUpCodes).values({
      userId: user.sub,
      sessionId: user.sid,
      codeHash: hashField(code, dbEnv.PII_HASH_KEY as string),
      expiresAt: new Date(Date.now() + TTL_MS),
    });

    await this.writeAuditSafe(user, 'auth.step_up_requested');

    const result = await this.email.send({
      to: recipient.email,
      subject: 'EMAPP: קוד אימות לצפייה במסמכים רגישים',
      text:
        `קוד האימות שלך לפתיחת מסמכים רגישים: ${code}\n` +
        `הקוד תקף לחמש דקות ולחיבור הנוכחי בלבד.\n` +
        `אם לא ביקשת קוד זה, ניתן להתעלם מהודעה זו.`,
    });
    // Observability only — PII-free (user/org UUIDs + provider status; NEVER
    // the code or the email body).
    if (result.status === 'rejected') {
      this.logger.warn(
        `step-up email not delivered (provider status=${result.status}) ` +
          `for org=${user.orgId} user=${user.sub}: ${result.error ?? 'unknown'}`,
      );
    }

    // 7c dev/QA exposure (EXPOSE_INVITE_TOKEN pattern) — fail-closed:
    // production / unset / typo'd NODE_ENV or a missing flag → {}.
    return exposeStepUpCode() ? { code } : {};
  }

  /**
   * Verify the step-up OTP and stamp pii_unlocked_at on the CALLER'S CURRENT
   * session ONLY. Generic 401 on EVERY failure (unknown sid / expired / used /
   * wrong code / attempts exhausted) — no oracle. Mirrors the tenant OTP
   * lockout: attempts increment per wrong try; after MAX_ATTEMPTS even the
   * correct code rejects (the row is burned via used_at).
   */
  async verify(user: AccessTokenPayload, code: string): Promise<void> {
    const invalid = new UnauthorizedException({
      error: { code: 'invalid_step_up_code', message: 'קוד שגוי או שפג תוקפו' },
    });

    // Session-bound lookup: a sid with no requested code (incl. a ghost sid
    // that never existed) finds nothing → generic reject, nothing stamped.
    const [row] = await db
      .select()
      .from(stepUpCodes)
      .where(
        and(
          eq(stepUpCodes.userId, user.sub),
          eq(stepUpCodes.sessionId, user.sid),
          isNull(stepUpCodes.usedAt),
        ),
      )
      .orderBy(desc(stepUpCodes.createdAt))
      .limit(1);

    if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= MAX_ATTEMPTS) {
      throw invalid;
    }

    const attempts = row.attempts + 1;
    const ok = row.codeHash === hashField(code, dbEnv.PII_HASH_KEY as string);
    await db
      .update(stepUpCodes)
      .set({ attempts, usedAt: ok || attempts >= MAX_ATTEMPTS ? new Date() : null })
      .where(eq(stepUpCodes.id, row.id));
    if (!ok) throw invalid;

    // Stamp the CALLER'S CURRENT session ONLY — and only if it is still a
    // LIVE auth_sessions row (defence in depth: the code row above was bound
    // to this sid, but the session may have been revoked since). The
    // RETURNING guard makes a no-row stamp a hard reject, never a silent ok.
    const stamped = (await db
      .update(authSessions)
      .set({ piiUnlockedAt: new Date() })
      .where(
        and(
          eq(authSessions.id, user.sid),
          eq(authSessions.userId, user.sub),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, new Date()),
        ),
      )
      .returning({ id: authSessions.id })) as Array<{ id: string }>;
    if (stamped.length === 0) throw invalid;

    await this.writeAuditSafe(user, PII_UNLOCK_AUDIT_ACTION);
  }

  // Best-effort audit write that never breaks the unlock flow if it itself
  // fails (same posture as the tenant OTP's writeAuditSafe). Explicit org_id;
  // the actor is a real org user so actor_id is set (unlike the tenant flow).
  private async writeAuditSafe(user: AccessTokenPayload, action: string): Promise<void> {
    try {
      await db.insert(auditLog).values({
        orgId: user.orgId,
        actorId: user.sub,
        actorType: 'user',
        action,
        targetTable: 'auth_sessions',
        targetId: user.sid,
        sessionId: user.sid,
        ip: user.ip,
        userAgent: user.userAgent,
      });
    } catch {
      // Best-effort: an audit-write failure must not surface to the user.
    }
  }
}
