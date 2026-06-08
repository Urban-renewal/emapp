/**
 * The `reaper:expired-rows` job — Phase 3 #5a (periodic maintenance).
 *
 * §v8-L5: lazily-expired rows in auth_sessions, tenant_sessions,
 * otp_codes, and cache_kv accumulate forever because nothing deletes
 * them on a schedule (the app paths only ever IGNORE expired rows, they
 * never reap them). This is the FIRST consumer of the new periodic-
 * runner infrastructure: a cron-scheduled job whose handler runs a
 * bounded DELETE per target table, keeping the tables from growing
 * without limit.
 *
 * NO payload. The reaper is a pure tick — it has no per-invocation
 * parameters. pg-boss's `schedule(name, cron)` enqueues a job with an
 * empty `{}` data object on each cron fire; the schema below validates
 * exactly that (strict empty object) so a tampered enqueue carrying
 * unexpected fields is rejected before the handler runs.
 */
import { z } from 'zod';

/** Job name registered with pg-boss. Namespaced with `reaper:` so future
 *  periodic consumers (signature expired-status, task due-firing, R2
 *  purge-retry) can share the same scheduler infrastructure without
 *  colliding with the `import.excel` work queue. */
export const REAPER_JOB_NAME = 'reaper:expired-rows' as const;

/** Cron cadence — hourly, on the hour. Expired auth/OTP/cache rows are
 *  already treated as absent by the app the instant they expire, so the
 *  reaper is pure housekeeping: hourly keeps the tables bounded without
 *  adding meaningful DB load (one small indexed DELETE per table). The
 *  cron is evaluated by pg-boss in UTC (its `schedule` default tz). */
export const REAPER_CRON_HOURLY = '0 * * * *' as const;

/** Validated payload. The reaper takes NO parameters — `.strict()` on an
 *  empty object means any extra field is rejected, matching the rest of
 *  the codebase's defense against payload confusion on the shared queue. */
export const ReaperJobPayloadSchema = z.object({}).strict();

export type ReaperJobPayload = z.infer<typeof ReaperJobPayloadSchema>;
