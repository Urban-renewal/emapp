import type { ICacheProvider } from '../providers/cache/cache.interface';

/**
 * Stats-cache epoch — the SINGLE source of truth for the per-org stats
 * invalidation counter shared between the api `StatsCacheService` (read-through
 * over `orgStats` + `signatureProgress`) and the worker's import materialiser.
 *
 * ── WHY THIS LIVES IN @emapp/db ───────────────────────────────────────────
 * The api `StatsCacheService` invalidates the stats cache by bumping a per-org
 * epoch counter at `stats:epoch:org:<orgId>`. The owner/apartment IMPORT is
 * materialised by the WORKER (plain pg-boss, NOT NestJS — it cannot inject the
 * api service), yet it changes `orgStats.residents` + `signatureProgress`
 * denominators. Both processes therefore need to bump the SAME counter under
 * the SAME key. Duplicating the key string in two packages risks silent drift
 * (a one-character divergence = a write that never invalidates). This module is
 * the one definition both import.
 *
 * ── TENANT ISOLATION ──────────────────────────────────────────────────────
 * `cache_kv` has NO `org_id` column and NO RLS — isolation is enforced ENTIRELY
 * by the `org:<orgId>` segment in the key. Never produce an epoch key without
 * it (cross-tenant leak). See StatsCacheService's doc-comment for the full
 * envelope/epoch read-through contract.
 */

/** TTL for the per-org epoch counter. Long — losing the epoch only means the
 *  counter restarts at 1 (which abandons the old keys, i.e. invalidates), so
 *  the worst case of expiry is a one-time cold recompute, never a stale read. */
export const STATS_EPOCH_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The per-org stats epoch key. MUST stay byte-identical to the value the api
 * `StatsCacheService` reads on the hot path — the stats-cache specs are the
 * proof that this string and the service agree.
 */
export function statsEpochKey(orgId: string): string {
  return `stats:epoch:org:${orgId}`;
}

/**
 * Bump the org's stats epoch, atomically invalidating every previously-cached
 * orgStats + signatureProgress envelope for that org (each carries a now-stale
 * stamped epoch). One UPSERT; callers wrap this best-effort — a cache failure
 * must NEVER fail the underlying write/materialisation.
 */
export async function bumpStatsEpoch(cache: ICacheProvider, orgId: string): Promise<void> {
  await cache.incrementCounter(statsEpochKey(orgId), STATS_EPOCH_TTL_SECONDS);
}
