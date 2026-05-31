import { createHash, randomBytes } from 'node:crypto';

import { authSessions, memberships, tenantSessions } from '@emapp/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

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

/**
 * D.49 — revoke every ACTIVE session for ALL ACTIVE members of an org.
 * Used when a Provider Admin suspends a tenant: existing access tokens stop
 * authenticating within <=15s (immediately after `flushSessionCache()`), and
 * any refresh attempt fails (refresh re-checks `revoked_at`). Returns the
 * number of sessions revoked. The member sub-select is scoped by `org_id`,
 * so a member's sessions in OTHER orgs are untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function revokeAllForOrg(db: any, orgId: string): Promise<number> {
  const revoked = (await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        isNull(authSessions.revokedAt),
        inArray(
          authSessions.userId,
          db
            .select({ userId: memberships.userId })
            .from(memberships)
            .where(and(eq(memberships.orgId, orgId), isNull(memberships.revokedAt))),
        ),
      ),
    )
    .returning({ id: authSessions.id })) as Array<{ id: string }>;
  return revoked.length;
}

/**
 * D.49 — revoke every ACTIVE tenant-portal (resident) session for an org.
 * Companion to `revokeAllForOrg` for the Tenant tier: when a Provider Admin
 * suspends a tenant, the resident SMS-OTP portal is frozen too. `tenant_sessions`
 * carries `org_id` directly (unlike auth_sessions), so this is a straight
 * org-scoped update. Returns the number of sessions revoked. Reactivate does
 * NOT un-revoke (re-OTP required — safe direction).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function revokeTenantSessionsForOrg(db: any, orgId: string): Promise<number> {
  const revoked = (await db
    .update(tenantSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(tenantSessions.orgId, orgId), isNull(tenantSessions.revokedAt)))
    .returning({ id: tenantSessions.id })) as Array<{ id: string }>;
  return revoked.length;
}

export const REFRESH_TTL_MS_EXPORT = REFRESH_TTL_MS;
