/**
 * D.37 / Phase 6.5 — Provider system-health gauges.
 *
 * `GET /provider/system-health` — read-only numeric snapshot for
 * the operations dashboard. No per-row data, no PII surface possible
 * (the response shape is pure numbers + one timestamp).
 *
 * Three gauge groups:
 *   - queue — pg-boss job counts by state via direct SQL into the
 *             pgboss schema. Worker owns DDL; the API has SELECT
 *             rights. Pivoted into 5 buckets: created / active /
 *             retry / failed / completed.
 *   - pool  — node-postgres pool gauges (total/idle/waiting) for
 *             both app + provider pools via `getPoolStats()`. Pure
 *             in-memory reads from pg-pool's own counters.
 *   - r2    — counter + lastErrorAt from the storage-error observer
 *             wired into R2StorageProvider. Process-local.
 *
 * **Audit v1.1 closures.**
 *
 * **CC-5 (HIGH, perf)** — 5 Admins polling every 5 s = 60 DB hits/min
 * for the queue probe. The pg-boss `GROUP BY state` has no supporting
 * index (CC-5b deferred index in a worker migration); a 30-second
 * in-process cache absorbs 29/30 polls without a DB hit while still
 * writing the per-call audit row (the audit obligation is per access,
 * the gauge value is per ops window).
 *
 * **SOLID-S4 (MEDIUM, SRP)** — the queue-probe SAVEPOINT discipline
 * is now its own private helper. `read()` orchestrates: audit-wrap,
 * cache-check, gauge-assemble.
 *
 * **SA-7 closure note** — `withProvider` now commits the audit row in
 * an autonomous transaction; the SAVEPOINT below is no longer needed
 * for audit-row preservation, only for the work tx's own cleanliness
 * when the pgboss schema is missing.
 *
 * Auditing a health-check seems heavy-handed but is correct: every
 * Provider tier access — INCLUDING ops-level snapshots — leaves a
 * forensic record (D.37 invariant, ISO A.12.4).
 */
import { getPoolStats, getStorageErrorStats, withProvider } from '@emapp/db';
import type { SystemHealth } from '@emapp/shared-types';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ProviderActor } from './current-provider.decorator';

// Type alias (not interface) for drizzle's tx.execute<T> constraint —
// see the same note in provider-tenant-detail.service.ts (TS2344).
type QueueStateRow = { state: string; cnt: number };

interface QueueCounts {
  created: number;
  active: number;
  retry: number;
  failed: number;
  completed: number;
}

/**
 * Audit v1.1 CC-5 — module-scoped cache for the assembled
 * `SystemHealth` response. 30-second TTL chosen to absorb the
 * dashboard's 5-second poll cadence × 5 admins (60 polls/min → 2
 * DB fetches/min). The cache value is the entire response shape so
 * even the `timestamp` field is consistent within a window (admins
 * polling within 30 s see the same snapshot).
 *
 * Race-safety: two concurrent cold-cache reads each issue one DB
 * fetch; whichever finishes last wins the cache slot. The losing
 * write is benign — both values are valid for the same 30 s window.
 *
 * Process-local by design; per-pod state is acceptable for an ops
 * dashboard gauge (cross-pod drift bounded to 30 s).
 */
const HEALTH_CACHE_TTL_MS = 30_000;
let healthCache: { value: SystemHealth; expiresAt: number } | null = null;

/**
 * Test-only seam — clears the cache so each spec starts from a known
 * baseline. Production code MUST NOT call this; the cache is part of
 * the audit-correctness contract.
 */
export function resetSystemHealthCacheForTests(): void {
  healthCache = null;
}

@Injectable()
export class ProviderSystemHealthService {
  async read(actor: ProviderActor, reason: string): Promise<SystemHealth> {
    // Audit row is written autonomously by `withProvider` BEFORE the
    // callback runs (SA-7 closure). Returning a cached value below
    // still leaves the per-call audit obligation satisfied.
    return withProvider(
      actor.sub,
      reason,
      async (tx) => {
        const now = Date.now();
        if (healthCache && healthCache.expiresAt > now) {
          // Cache hit — no DB work, same shape as fresh.
          return healthCache.value;
        }
        // Cache miss — assemble fresh.
        const queue = await probeQueueCounts(tx);
        const poolStats = getPoolStats();
        const r2Stats = getStorageErrorStats();
        const fresh: SystemHealth = {
          queue,
          pool: { app: poolStats.app, provider: poolStats.provider },
          r2: { errorsSinceBoot: r2Stats.errorsSinceBoot, lastErrorAt: r2Stats.lastErrorAt },
          timestamp: new Date(),
        };
        healthCache = { value: fresh, expiresAt: now + HEALTH_CACHE_TTL_MS };
        return fresh;
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'pgboss.job',
        action: 'provider.health.read',
        metadata: { endpoint: 'system-health' },
      },
    );
  }
}

/**
 * Probe `pgboss.job` for current per-state counts.
 *
 * SCHEMA-LAZINESS: pg-boss creates its schema lazily on first
 * `pgboss.start()` (the worker process). If the API boots before
 * the worker has ever run (CI's fresh Postgres, fresh staging,
 * dev sandbox without `pnpm dev:worker`) then `pgboss.job` simply
 * doesn't exist and the SELECT raises PG 42P01 (undefined_table)
 * or 3F000 (invalid_schema_name). That is NOT a failure of the
 * health check; it is the queue being empty before the schema
 * exists. Return zeros — semantically equivalent — and let the
 * worker create the schema on its first start. Any other error
 * class re-raises (a real outage MUST still alert).
 *
 * SAVEPOINT discipline: pre-SA-7 the wrapper's audit INSERT shared
 * the same tx; a poisoned outer tx would roll the audit row away.
 * With SA-7 closure the audit row commits autonomously BEFORE this
 * runs, so the SAVEPOINT here only protects the work tx itself.
 * Kept for hygiene — the work tx still cannot continue once aborted
 * unless we ROLLBACK TO the savepoint.
 */
async function probeQueueCounts(tx: NodePgDatabase<Record<string, unknown>>): Promise<QueueCounts> {
  await tx.execute(sql`SAVEPOINT queue_probe`);
  try {
    const rows = await tx.execute<QueueStateRow>(sql`
      SELECT state, COUNT(*)::int AS cnt
      FROM pgboss.job
      GROUP BY state
    `);
    await tx.execute(sql`RELEASE SAVEPOINT queue_probe`);
    const byState: Record<string, number> = {};
    for (const r of rows.rows) byState[r.state] = Number(r.cnt);
    return {
      created: byState['created'] ?? 0,
      active: byState['active'] ?? 0,
      retry: byState['retry'] ?? 0,
      failed: byState['failed'] ?? 0,
      completed: byState['completed'] ?? 0,
    };
  } catch (e) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT queue_probe`).catch(() => undefined);
    if (isPgbossSchemaMissingError(e)) {
      return { created: 0, active: 0, retry: 0, failed: 0, completed: 0 };
    }
    throw e;
  }
}

/**
 * Drizzle wraps the pg error in `DrizzleQueryError` and puts the
 * original PG error on `.cause` — the `code` field we want is
 * therefore on `e.cause.code`, not on `e.code`. Check both locations
 * to be defensive against future drizzle refactors that might
 * surface the code directly. Exported as a named helper so other
 * callers can reuse the same check (SOLID-S4 closure).
 *
 * 42P01 = undefined_table, 3F000 = invalid_schema_name. Both mean
 * "pgboss hasn't initialised yet" → empty queue.
 */
function isPgbossSchemaMissingError(e: unknown): boolean {
  const outer = e as { code?: string; cause?: { code?: string } } | null;
  const code = outer?.code ?? outer?.cause?.code;
  return code === '42P01' || code === '3F000';
}
