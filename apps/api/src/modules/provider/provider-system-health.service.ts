/**
 * D.37 / Phase 6.5 — Provider system-health gauges.
 *
 * `GET /provider/system-health` — read-only numeric snapshot for
 * the operations dashboard. No per-row data, no PII surface possible
 * (the response shape is pure numbers + one timestamp).
 *
 * Three gauge groups:
 *   - queue   — pg-boss job counts by state via direct SQL into the
 *               pgboss schema. Worker owns DDL of that schema; the
 *               API has SELECT rights. We pivot the `state` column
 *               into 5 buckets: created / active / retry / failed /
 *               completed. (pg-boss state vocabulary documented in
 *               https://github.com/timgit/pg-boss/blob/master/docs/readme.md#job-states)
 *   - pool    — node-postgres pool gauges (total/idle/waiting) for
 *               both app + provider pools via `getPoolStats()` from
 *               `@emapp/db`. Direct pool access is internal (D.21);
 *               the new accessor returns NUMBERS only.
 *   - r2      — counter + lastErrorAt from the storage-error observer
 *               wired into R2StorageProvider. Counter is process-
 *               local (resets on restart); good enough for a health
 *               gauge — long-term aggregation belongs to Sentry.
 *
 * Audit row: `action='provider.health.read'`, no targetTable (the
 * call doesn't target a row), metadata.endpoint='system-health'.
 *
 * Auditing a health-check seems heavy-handed but is correct: every
 * Provider tier access — INCLUDING ops-level snapshots — leaves a
 * forensic record (D.37 invariant, ISO A.12.4).
 */
import { getPoolStats, getStorageErrorStats, withProvider } from '@emapp/db';
import type { SystemHealth } from '@emapp/shared-types';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { ProviderPrincipal } from './current-provider.decorator';

// Type alias (not interface) for drizzle's tx.execute<T> constraint —
// see the same note in provider-tenant-detail.service.ts (TS2344).
type QueueStateRow = { state: string; cnt: number };

@Injectable()
export class ProviderSystemHealthService {
  async read(actor: ProviderPrincipal, reason: string): Promise<SystemHealth> {
    const timestamp = new Date();

    const queue = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        // GROUP BY the pg-boss state enum. Returns up to N rows;
        // we pivot to our 5-bucket shape. Buckets we don't see
        // default to 0. The `archive` schema split that pg-boss
        // does once jobs are old enough means `completed` here is
        // ONLY the active-state-table completion count, not the
        // historical archive — the gauge is "current shape of the
        // queue", not "lifetime job count".
        //
        // SCHEMA-LAZINESS: pg-boss creates its schema lazily on the
        // first `pgboss.start()` (the worker process). If the API
        // boots BEFORE the worker has ever run — CI's fresh Postgres,
        // a new staging DB, a dev sandbox without `pnpm dev:worker`
        // — then `pgboss.job` simply doesn't exist yet and the query
        // raises PG error 42P01 (undefined_table). That is NOT a
        // failure of the health check; it is the queue being empty
        // before the schema exists. Return zeros — semantically the
        // same as "the queue has no jobs right now" — and let the
        // worker create the schema on its first start. Any other
        // error class re-raises (a real outage must still alert).
        try {
          const rows = await tx.execute<QueueStateRow>(sql`
            SELECT state, COUNT(*)::int AS cnt
            FROM pgboss.job
            GROUP BY state
          `);
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
          const code = (e as { code?: string } | null)?.code;
          // 42P01 = undefined_table, 3F000 = invalid_schema_name.
          // Both mean "pgboss hasn't initialised yet" → empty queue.
          if (code === '42P01' || code === '3F000') {
            return { created: 0, active: 0, retry: 0, failed: 0, completed: 0 };
          }
          throw e;
        }
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'pgboss.job',
        action: 'provider.health.read',
        metadata: {
          endpoint: 'system-health',
        },
      },
    );

    const poolStats = getPoolStats();
    const r2Stats = getStorageErrorStats();

    return {
      queue,
      pool: {
        app: poolStats.app,
        provider: poolStats.provider,
      },
      r2: {
        errorsSinceBoot: r2Stats.errorsSinceBoot,
        lastErrorAt: r2Stats.lastErrorAt,
      },
      timestamp,
    };
  }
}
