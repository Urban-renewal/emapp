/**
 * Audit v1.1 SA-12 closure — `SYSTEM_STATS_PROVIDER` DI token.
 *
 * Pre-closure, `ProviderSystemHealthService` reached directly into
 * `@emapp/db` for `getPoolStats()` + `getStorageErrorStats()`. That
 * mixes layers — the service couples to a concrete module surface
 * instead of a narrow port — and it leaves no test seam for swapping
 * the values without monkey-patching ESM imports.
 *
 * SA-12 mirrors the same governed-DI pattern already in use for
 * `STORAGE_PROVIDER` (`documents/storage.ts`) and `JOB_PRODUCER`
 * (`queue/queue.module.ts`):
 *   - A narrow interface exposes only the methods the consumer needs.
 *   - A string token survives across module-graph boundaries.
 *   - A default factory delegates to the `@emapp/db` functions in
 *     production; tests can `useValue` or `useFactory` a fake without
 *     touching the global module state.
 *
 * The interface is read-only by design. The R2 + pool counters are
 * WRITTEN from inside `@emapp/db` (R2 SDK error handler, pg-pool
 * 'connect' listener); the Provider tier only READS them. Keeping the
 * write surface out of this interface preserves the Interface
 * Segregation principle (CC-4 in spirit).
 */
import {
  getPoolStats,
  getStorageErrorStats,
  type AllPoolsStats,
  type StorageErrorStats,
} from '@emapp/db';

export const SYSTEM_STATS_PROVIDER = 'SYSTEM_STATS_PROVIDER' as const;

export interface ISystemStatsProvider {
  /** Snapshot of pg-pool gauges for the app + provider pools. */
  getPoolStats(): AllPoolsStats;
  /** Snapshot of the storage-error counter populated by R2StorageProvider. */
  getStorageErrorStats(): StorageErrorStats;
}

/**
 * Default production provider — delegates to `@emapp/db`. Memoising
 * isn't necessary (the underlying functions are pure reads of
 * module-scoped counters); a fresh delegating object per Nest provider
 * resolution is cheap and matches the JOB_PRODUCER class-provider
 * convention.
 */
export class DefaultSystemStatsProvider implements ISystemStatsProvider {
  getPoolStats(): AllPoolsStats {
    return getPoolStats();
  }

  getStorageErrorStats(): StorageErrorStats {
    return getStorageErrorStats();
  }
}
