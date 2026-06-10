import { createHash, randomBytes } from 'node:crypto';

import { passwordResetTokens } from '@emapp/db';
import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';

// ── Token primitives (P1 R0.1, OWASP Forgot-Password) ───────────────────────
// Raw reset token = 256-bit random; ONLY its SHA-256 hash is ever stored
// (mirrors the refresh-token posture in session.repository.ts). The raw token
// is returned once, embedded in the emailed link, and never persisted or
// logged. A DB/backup leak yields no usable reset links.
export function newRawResetToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// Short expiry (OWASP: keep the window small). 30 min is the documented cap.
const RESET_TTL_MS = 30 * 60 * 1000;
export const RESET_TTL_MS_EXPORT = RESET_TTL_MS;

// Per-email abuse cap (defence-in-depth BELOW the per-IP throttler): at most
// this many active (un-used, un-expired) mint requests inside the TTL window
// per user. Blocks an attacker spraying a single known address to flood the
// victim's inbox / exhaust the token table. The generic 200 is returned
// regardless, so this is NOT an enumeration oracle.
const MAX_ACTIVE_PER_USER = 3;

// Minimal structural type for the BYPASSRLS `db` pool / a tx — kept local so
// this repository depends only on the drizzle surface it actually uses, not on
// the concrete pool type (DIP).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface ResetTokenRow {
  id: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * Single-responsibility password-reset token store: mint / verify / consume.
 *
 * Pre-auth by necessity (the user has no session during reset, no org context)
 * — reads/writes go through the raw BYPASSRLS `db` pool passed in by the
 * caller, exactly like the login/loadProfile bootstrap reads (D.21). No PII is
 * stored or returned.
 */
@Injectable()
export class PasswordResetRepository {
  /**
   * Mint a reset token for a user. Returns the RAW token (the caller emails it;
   * never logs it). Stores only the hash + a short expiry. Honours the per-user
   * active-token cap — when exceeded, returns `null` (no token minted, no
   * email) WITHOUT signalling anything to the user (the caller still answers a
   * generic 200).
   */
  async mint(db: Db, userId: string, requestedIp?: string): Promise<string | null> {
    const windowStart = new Date(Date.now() - RESET_TTL_MS);
    const [active] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          isNull(passwordResetTokens.usedAt),
          gte(passwordResetTokens.createdAt, windowStart),
        ),
      )) as Array<{ n: number }>;
    if ((active?.n ?? 0) >= MAX_ACTIVE_PER_USER) return null;

    const raw = newRawResetToken();
    await db.insert(passwordResetTokens).values({
      userId,
      tokenHash: hashResetToken(raw),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
      requestedIp: requestedIp ?? null,
    });
    return raw;
  }

  /**
   * Look up a token by its raw value (hashed for the query). Returns the row
   * (incl. used/expiry state) or undefined. The caller decides validity — this
   * is a pure read so the same generic error can be returned for not-found /
   * expired / used (no oracle).
   */
  async findByRawToken(db: Db, rawToken: string): Promise<ResetTokenRow | undefined> {
    const [row] = (await db
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        expiresAt: passwordResetTokens.expiresAt,
        usedAt: passwordResetTokens.usedAt,
      })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashResetToken(rawToken)))
      .limit(1)) as ResetTokenRow[];
    return row;
  }

  /**
   * Atomically consume a token (single-use). Flips `used_at` NULL→now ONLY if
   * it is still NULL — the conditional UPDATE closes the replay/double-spend
   * TOCTOU (same guard as the refresh-rotation flip + the public-sign single-
   * use guard). Returns true iff THIS call won the race; a concurrent second
   * consume of the same token flips 0 rows → false. Runs inside the caller's
   * transaction (`tx`) so it commits atomically with the password update.
   */
  async consume(tx: Db, tokenId: string): Promise<boolean> {
    const flipped = (await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.id, tokenId), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id })) as Array<{ id: string }>;
    return flipped.length > 0;
  }

  /**
   * Invalidate every other un-used token for a user (defence-in-depth: a
   * successful reset, or a fresh mint, supersedes prior outstanding links).
   * Runs inside the caller's tx. Returns the number invalidated.
   */
  async invalidateAllForUser(tx: Db, userId: string, exceptTokenId?: string): Promise<number> {
    const predicate = exceptTokenId
      ? and(
          eq(passwordResetTokens.userId, userId),
          isNull(passwordResetTokens.usedAt),
          sql`${passwordResetTokens.id} <> ${exceptTokenId}`,
        )
      : and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt));
    const rows = (await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(predicate)
      .returning({ id: passwordResetTokens.id })) as Array<{ id: string }>;
    return rows.length;
  }
}
