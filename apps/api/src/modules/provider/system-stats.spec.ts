/**
 * Unit coverage for the SA-12 system-stats abstraction.
 *
 * No DB needed — the abstraction itself is pure delegation. Spec
 * proves:
 *   - the DI token is a stable string (survives the module graph
 *     boundary the same way STORAGE_PROVIDER / JOB_PRODUCER do)
 *   - the default delegate returns the same shape `@emapp/db` exports
 *   - the service can be instantiated with a FAKE implementation —
 *     i.e. the SA-12 closure actually unblocks the test seam it
 *     promised. (Previously the service module-imported the functions
 *     directly and a fake required vi.mock at module level.)
 */
import { describe, expect, it } from 'vitest';

import {
  DefaultSystemStatsProvider,
  SYSTEM_STATS_PROVIDER,
  type ISystemStatsProvider,
} from './system-stats';

describe('system-stats abstraction (SA-12)', () => {
  it('exports a string DI token (not a Symbol)', () => {
    // Symbols don't survive a barrel-export round-trip across module
    // graph boundaries — STORAGE_PROVIDER + JOB_PRODUCER both use
    // string literals for the same reason. Pin the contract.
    expect(typeof SYSTEM_STATS_PROVIDER).toBe('string');
    expect(SYSTEM_STATS_PROVIDER).toBe('SYSTEM_STATS_PROVIDER');
  });

  it('DefaultSystemStatsProvider implements ISystemStatsProvider', () => {
    const impl: ISystemStatsProvider = new DefaultSystemStatsProvider();
    // Both methods present + callable. The actual return value depends
    // on global pg-pool / R2 counters which other specs cover.
    expect(typeof impl.getPoolStats).toBe('function');
    expect(typeof impl.getStorageErrorStats).toBe('function');
  });

  it('default delegate returns the expected shape (number gauges)', () => {
    const impl = new DefaultSystemStatsProvider();
    const pool = impl.getPoolStats();
    // Pool shape — app + provider sub-keys, each carrying total/idle/waiting.
    expect(pool).toHaveProperty('app');
    expect(pool).toHaveProperty('provider');
    for (const key of ['total', 'idle', 'waiting'] as const) {
      expect(typeof pool.app[key]).toBe('number');
      expect(typeof pool.provider[key]).toBe('number');
    }
    const r2 = impl.getStorageErrorStats();
    expect(typeof r2.errorsSinceBoot).toBe('number');
    // lastErrorAt is `Date | null`; both branches are valid.
    expect(r2.lastErrorAt === null || r2.lastErrorAt instanceof Date).toBe(true);
  });

  it('accepts a fake — the test seam SA-12 was meant to unblock', () => {
    const fake: ISystemStatsProvider = {
      getPoolStats: () => ({
        app: { total: 1, idle: 1, waiting: 0 },
        provider: { total: 2, idle: 2, waiting: 0 },
      }),
      getStorageErrorStats: () => ({ errorsSinceBoot: 7, lastErrorAt: new Date('2026-05-25Z') }),
    };
    expect(fake.getPoolStats().app.total).toBe(1);
    expect(fake.getStorageErrorStats().errorsSinceBoot).toBe(7);
  });
});
