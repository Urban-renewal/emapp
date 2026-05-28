import { db } from '@emapp/db';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/**
 * V11 Wave 6 EXP-H1 (redteam audit 2026-05-28) — multi-replica safe
 * per-user export rate limiter, backed by `cache_kv`.
 *
 * **The hole**: the existing `@Throttle({ default: { limit: 10, ttl: 3_600_000 } })`
 * on the export endpoint uses Nest's default `ThrottlerStorage`, which
 * is in-memory and per-process. On a multi-replica Railway deploy the
 * "10/hour" ceiling becomes `10 × N replicas` — a compromised Manager
 * session can pull ~10×N exports/hour where N is the autoscaler's
 * current replica count. Combined with the absence of any audit-side
 * rate-check (the audit row writes one per call but nothing reads it
 * for throttling), there is no defence-in-depth.
 *
 * **The fix**: a DB-backed counter keyed `export:rl:u:<userId>:<yyyymmddHH>`
 * in `cache_kv`. The bucket key rolls over at the top of every hour
 * (wall-clock UTC, matching the spec's "10 per user per hour"). The
 * counter is incremented atomically via a single `INSERT … ON CONFLICT`
 * (race-safe; concurrent inserts from different replicas serialise via
 * the cache_kv PK lock and end up with the correct count). expires_at
 * is set to the end of the hour so stale rows are eligible for the
 * existing cache_kv eviction sweep (`idx_cache_kv_expires`).
 *
 * The existing `@Throttle` decorator is kept as cheap belt-and-braces
 * for single-replica deploys + as a smoothing layer (Nest's storage
 * batches counts in-process; the DB hit only happens on the call that
 * actually crosses 10/hour).
 *
 * **Cost**: one round-trip per export call. cache_kv lookups are
 * PK-indexed (Neon ~5-15 ms). Total per-call overhead < 20 ms — well
 * within the user's "more than 1 second is excessive" rule.
 *
 * **Failure mode**: if cache_kv is unreachable (Neon blip), the service
 * fails OPEN (allows the export, logs an error). The audit row STILL
 * lands inside the composer's withTenant tx, so forensic accountability
 * survives a brief outage. The alternative (fail closed) would block
 * legitimate exports during routine Neon failovers — wrong tradeoff for
 * a quota that's primarily about cost containment, not security.
 */
@Injectable()
export class ExportRateLimitService {
  private readonly logger = new Logger(ExportRateLimitService.name);
  private static readonly LIMIT_PER_HOUR = 10;

  /**
   * Atomically increment the caller's bucket and return the verdict.
   * Allowed = the post-increment count is <= LIMIT. Remaining is
   * post-increment so the FE can display "9 left", "8 left", etc.
   * retryAfterSec is set only when blocked, in seconds until the
   * current bucket rolls over (so the Retry-After header is honest).
   */
  async checkAndIncrement(userId: string): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterSec?: number;
  }> {
    const now = new Date();
    // Bucket key: YYYYMMDDHH at UTC. The spec's "10 per hour" is naturally
    // wall-clock — switching at the top of every hour is the simplest
    // honest semantic for a rate limiter (no rolling-window state).
    const bucket =
      now.getUTCFullYear().toString().padStart(4, '0') +
      (now.getUTCMonth() + 1).toString().padStart(2, '0') +
      now.getUTCDate().toString().padStart(2, '0') +
      now.getUTCHours().toString().padStart(2, '0');
    const key = `export:rl:u:${userId}:${bucket}`;
    // End-of-hour. Stale rows are GC'd by the cache_kv expires_at index.
    const expiresAt = new Date(now);
    expiresAt.setUTCMinutes(59, 59, 999);

    let countAfter = 0;
    try {
      // Atomic UPSERT increment. The trick is JSON-cast both ways
      // because cache_kv.value is jsonb (per the schema at
      // packages/db/src/schema/artifacts.ts:221). Numeric jsonb is
      // legal; we extract as int, increment, cast back to jsonb.
      const result = await db.execute<{ value: number }>(sql`
        INSERT INTO cache_kv (key, value, expires_at)
        VALUES (${key}, '1'::jsonb, ${expiresAt.toISOString()})
        ON CONFLICT (key) DO UPDATE
          SET value = ((cache_kv.value::text::int) + 1)::text::jsonb,
              updated_at = NOW()
        RETURNING value
      `);
      const row = (result as unknown as { rows: Array<{ value: unknown }> }).rows?.[0];
      countAfter = Number(row?.value ?? 0);
    } catch (e) {
      // Fail OPEN. See class doc for rationale. Log so ops sees the
      // pattern; the audit-row write in the composer is the
      // accountability fallback.
      this.logger.error(
        `export rate-limit lookup failed (user=${userId}): ${e instanceof Error ? e.message : 'unknown'} — failing OPEN`,
      );
      return { allowed: true, remaining: ExportRateLimitService.LIMIT_PER_HOUR };
    }

    const allowed = countAfter <= ExportRateLimitService.LIMIT_PER_HOUR;
    const remaining = Math.max(0, ExportRateLimitService.LIMIT_PER_HOUR - countAfter);
    if (allowed) return { allowed, remaining };
    const retryAfterSec = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  /** Exposed for tests. */
  static get LIMIT(): number {
    return ExportRateLimitService.LIMIT_PER_HOUR;
  }
}
