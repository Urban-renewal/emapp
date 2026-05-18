import { authSessions, db, providerSessions } from '@emapp/db';
import { eq } from 'drizzle-orm';

/**
 * Closes the stateless-JWT revocation hole WITHOUT a per-request DB hit.
 *
 * A valid access JWT carries `sid` (its refresh-chain session id). After
 * logout / reuse-detection / membership-revoke the refresh session is
 * revoked, but a stateless access token would otherwise stay valid for its
 * full TTL (≤15 min org / ≤30 min provider). We check the session is still
 * active — but the result is memoised in-process for a short window so it
 * costs an indexed PK lookup at most once per `TTL_MS` per session
 * (amortised ≈ 0), honouring "AuthGuard must not hit the DB per request".
 *
 * On logout / revoke-all / reuse-purge the service calls flushSessionCache()
 * → revocation is IMMEDIATE on this instance (MVP = single instance); other
 * instances converge within TTL_MS. Net: a 15-min hole becomes ≤15 s
 * (effectively immediate), at zero UX/latency cost.
 */
const TTL_MS = 15_000;

interface Entry {
  active: boolean;
  at: number;
}
const orgCache = new Map<string, Entry>();
const provCache = new Map<string, Entry>();

export function flushSessionCache(): void {
  orgCache.clear();
  provCache.clear();
}

async function check(kind: 'org' | 'provider', sid: string): Promise<boolean> {
  if (!sid) return false;
  const cache = kind === 'org' ? orgCache : provCache;
  const hit = cache.get(sid);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.active;

  let active = false;
  if (kind === 'org') {
    const [row] = await db
      .select({ revokedAt: authSessions.revokedAt, expiresAt: authSessions.expiresAt })
      .from(authSessions)
      .where(eq(authSessions.id, sid))
      .limit(1);
    active = !!row && !row.revokedAt && row.expiresAt.getTime() > now;
  } else {
    const [row] = await db
      .select({ revokedAt: providerSessions.revokedAt, expiresAt: providerSessions.expiresAt })
      .from(providerSessions)
      .where(eq(providerSessions.id, sid))
      .limit(1);
    active = !!row && !row.revokedAt && row.expiresAt.getTime() > now;
  }
  cache.set(sid, { active, at: now });
  return active;
}

export function isOrgSessionActive(sid: string): Promise<boolean> {
  return check('org', sid);
}
export function isProviderSessionActive(sid: string): Promise<boolean> {
  return check('provider', sid);
}
