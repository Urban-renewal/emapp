import { bumpStatsEpoch, statsEpochKey, type ICacheProvider } from '@emapp/db';
import { Inject, Injectable } from '@nestjs/common';

/**
 * E2 Wave-0 PERF (N9 — gates B0) — read-through cache for the two hottest,
 * per-request-recomputed aggregations: `ProjectsService.orgStats` and
 * `ProjectsService.signatureProgress`. B0 makes the consent calc strictly
 * heavier (share-weighted CTE), so this layer is the gate that proves the
 * board stays sub-second at 50 projects on a warm read.
 *
 * ── TENANT ISOLATION (the load-bearing invariant) ─────────────────────────
 * `cache_kv` has NO `org_id` column and NO RLS (migration 0007) — unlike
 * every customer-data table, isolation here CANNOT come from withTenant/RLS.
 * It is enforced ENTIRELY by the key: EVERY key embeds `org:<orgId>`, so two
 * orgs can never collide on a cache entry. A key without the org segment
 * would be a cross-tenant leak; do not add one.
 *
 * ── KEY SHAPE (pinned) ────────────────────────────────────────────────────
 *   epoch (per-org):   stats:epoch:org:<orgId>
 *   orgStats:          stats:org:<orgId>:orgStats:<scope>
 *   signatureProgress: stats:org:<orgId>:sigProgress:p:<projectId>
 *
 * `<scope>` is the part of the orgStats INPUT that varies its OUTPUT: an
 * agent sees counts scoped to their ASSIGNED projects, so the key carries
 * `agent:<userId>`; manager/viewer share the org-wide result → `all`. Two
 * agents therefore never read each other's scoped numbers, and an agent
 * never reads the manager's org-wide numbers.
 *
 * ── INVALIDATION (pinned: correctness over cleverness) ────────────────────
 * `<epoch>` is a per-org monotonic counter at `stats:epoch:org:<orgId>`. Each
 * cached value is stored as an ENVELOPE `{ e: <epoch-at-write>, v: <value> }`.
 * A read fetches the org's CURRENT epoch AND the value envelope in ONE
 * round-trip (`getMany`) and treats the value as a HIT only when
 * `envelope.e === currentEpoch`. A write that could change any consent input
 * calls `invalidateOrg(orgId)`, which atomically bumps the counter; every
 * previously-written envelope now carries a STALE epoch and is ignored on the
 * next read — the "invalidate broadly, a stale cache must NEVER return a wrong
 * consent %/count" rule, achieved by one cheap UPSERT. We do not surgically
 * delete the single affected project's key: a signature write keys off
 * `document_id` (not `project_id`), and an org-stats write spans many
 * projects, so resolving the exact affected key would be both costlier and a
 * correctness risk. Bumping one org counter is correct by construction; the
 * superseded envelopes TTL-expire (idx_cache_kv_expires sweep).
 *
 * Folding epoch+value into ONE `getMany` (vs two sequential `get`s) is the
 * difference between one and two Neon round-trips on the hot read.
 */
export const STATS_CACHE_PROVIDER = 'STATS_CACHE_PROVIDER';

/** TTL for a cached stats value. A safety net only — the epoch bump is the
 *  real invalidation, so this can be generous. 60s caps staleness if a write
 *  path is ever missed (defence in depth) without making the warm-path test
 *  flaky. */
const STATS_TTL_SECONDS = 60;

/** The per-org epoch counter's TTL + key now live in @emapp/db
 *  (`STATS_EPOCH_TTL_SECONDS` / `statsEpochKey`) so the worker's import
 *  materialiser and this service share ONE definition (no drift). They are
 *  consumed via `bumpStatsEpoch` in `invalidateOrg` below. */

/** The stored envelope — value `v` plus the epoch `e` it was computed at. A
 *  read accepts `v` only when `e` matches the org's current epoch. */
interface StatsEnvelope<T> {
  e: number;
  v: T;
}

@Injectable()
export class StatsCacheService {
  constructor(@Inject(STATS_CACHE_PROVIDER) private readonly cache: ICacheProvider) {}

  private epochKey(orgId: string): string {
    // Single source of truth in @emapp/db — byte-identical to the key the
    // worker bumps after an import materialises (shared `statsEpochKey`).
    return statsEpochKey(orgId);
  }

  /** The epoch-INDEPENDENT value key (the epoch lives inside the envelope). */
  private valueKey(orgId: string, keyParts: string): string {
    return `stats:org:${orgId}:${keyParts}`;
  }

  /**
   * Read-through in ONE round-trip: fetch the org's current epoch AND the value
   * envelope together. HIT iff the envelope exists and its stamped epoch equals
   * the current epoch; otherwise recompute via `fresh`, store an envelope
   * stamped with the current epoch, and return. A cached value can therefore
   * never be stale: a write bumps the epoch, instantly demoting every prior
   * envelope to a MISS on the next read.
   */
  async readThrough<T>(orgId: string, keyParts: string, fresh: () => Promise<T>): Promise<T> {
    const eKey = this.epochKey(orgId);
    const vKey = this.valueKey(orgId, keyParts);
    const batch = await this.cache.getMany<unknown>([eKey, vKey]);

    const rawEpoch = batch.get(eKey);
    const epoch = typeof rawEpoch === 'number' ? rawEpoch : 0;
    const env = batch.get(vKey) as StatsEnvelope<T> | undefined;
    if (env && env.e === epoch) return env.v;

    const value = await fresh();
    const envelope: StatsEnvelope<T> = { e: epoch, v: value };
    await this.cache.set<StatsEnvelope<T>>(vKey, envelope, STATS_TTL_SECONDS);
    return value;
  }

  /** orgStats key suffix — `all` for manager/viewer (org-wide), `agent:<id>`
   *  for an agent (scoped to their assigned projects). */
  orgStatsKey(scope: 'all' | { agentId: string }): string {
    return scope === 'all' ? 'orgStats:all' : `orgStats:agent:${scope.agentId}`;
  }

  /** signatureProgress key suffix — varies only by projectId. */
  signatureProgressKey(projectId: string): string {
    return `sigProgress:p:${projectId}`;
  }

  /**
   * E2 Wave-2 B1 — the signature-pulse per-project CONSENT-AGGREGATES key suffix.
   * Distinct from `signatureProgressKey` ON PURPOSE: the board caches the
   * ASSEMBLED `SignatureProgress` object under `sigProgress:p:<id>`, whereas the
   * pulse caches the RAW `computeConsentAggregates` shape — sharing one key
   * would store two different value shapes under it (an envelope clash). Same
   * per-org epoch invalidates BOTH (any consent-affecting write bumps the epoch),
   * so they stay coherent without sharing the value slot.
   */
  pulseConsentKey(projectId: string): string {
    return `pulseConsent:p:${projectId}`;
  }

  /**
   * Invalidate ALL cached orgStats + signatureProgress entries for one org by
   * bumping its epoch counter. One atomic UPSERT; never throws into the write
   * path's hot path — a cache failure must not fail the underlying write, so
   * callers wrap this best-effort (see ProjectsService / the write sites).
   */
  async invalidateOrg(orgId: string): Promise<void> {
    // Delegates to the shared @emapp/db helper: identical key (statsEpochKey)
    // + TTL (STATS_EPOCH_TTL_SECONDS) ⇒ zero behaviour change vs the previous
    // inline `incrementCounter(this.epochKey(orgId), EPOCH_TTL_SECONDS)`.
    await bumpStatsEpoch(this.cache, orgId);
  }
}
