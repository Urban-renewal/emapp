import { createHash, randomBytes } from 'node:crypto';

import { authSessions } from '@emapp/db';
import { and, eq, isNull } from 'drizzle-orm';

// Raw refresh token = 256-bit random; only its SHA-256 hash is ever stored
// (D.21). The raw token is returned once and lives only in the httpOnly
// cookie — a DB/backup leak yields no usable bearer tokens.
export function newRawToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Tx {
  insert: (t: typeof authSessions) => {
    values: (v: Record<string, unknown>) => { returning: () => Promise<Array<{ id: string }>> };
  };
}

export interface SessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

/** Create a session row for an already-issued raw token (inside a tx). */
export async function createSession(
  tx: Tx,
  userId: string,
  rawToken: string,
  ip?: string,
  userAgent?: string,
): Promise<string> {
  const [row] = await tx
    .insert(authSessions)
    .values({
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    })
    .returning();
  return row!.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function findByRawToken(db: any, rawToken: string): Promise<SessionRow | undefined> {
  const [row] = await db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
      revokedAt: authSessions.revokedAt,
      replacedBy: authSessions.replacedBy,
    })
    .from(authSessions)
    .where(eq(authSessions.tokenHash, hashToken(rawToken)))
    .limit(1);
  return row as SessionRow | undefined;
}

/** Revoke every active session for a user (logout, reuse-detection purge). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function revokeAllForUser(db: any, userId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
}

export const REFRESH_TTL_MS_EXPORT = REFRESH_TTL_MS;
