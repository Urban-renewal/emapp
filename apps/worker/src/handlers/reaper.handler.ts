/**
 * `reaper:expired-rows` handler — Phase 3 #5a.
 *
 * The FIRST consumer of the periodic-runner infrastructure. pg-boss's
 * cron (`boss.schedule(REAPER_JOB_NAME, REAPER_CRON_HOURLY)`, wired in
 * main.ts) enqueues an empty-payload job hourly; this handler runs the
 * per-table expired-row DELETEs via `reapExpiredRows` (in @emapp/db,
 * which owns the BYPASSRLS maintenance pool — see that module for the
 * pool-choice justification and the exact per-table predicates).
 *
 * Thin by design: the handler is the queue seam (name / timeout / retry
 * policy + a Zod-validated empty payload); the reap LOGIC lives in
 * @emapp/db so it is unit-testable without pg-boss and reusable by any
 * future trigger (e.g. an ops-invoked manual reap).
 *
 * Error policy: `reapExpiredRows` is best-effort PER TABLE — one table's
 * failure logs and the others still run. The job itself only THROWS (so
 * pg-boss retries on the next attempt) if EVERY target failed, which
 * signals a systemic problem (pool down, role lost BYPASSRLS) rather
 * than a single-table transient. A partial failure is logged at WARN and
 * the job completes — the next hourly tick will retry the laggards
 * anyway, so thrashing pg-boss retries on a partial result adds no value.
 */
import { reapExpiredRows, type ReapLogger } from '@emapp/db';
import {
  REAPER_JOB_NAME,
  ReaperJobPayloadSchema,
  type IJobHandler,
  type JobContext,
  type ReaperJobPayload,
} from '@emapp/jobs';

export class ReaperHandler implements IJobHandler<ReaperJobPayload> {
  readonly name = REAPER_JOB_NAME;

  /** 2 minutes — a handful of indexed DELETEs against small auth/cache
   *  tables completes in well under a second; the generous ceiling only
   *  guards against a pathological lock-wait. */
  readonly timeoutMs = 2 * 60 * 1000;

  /** No retries. The reaper is idempotent and runs hourly — a missed
   *  tick is reaped by the next one, so re-queuing a failed tick adds
   *  load without benefit. (The handler only throws on a total failure;
   *  pg-boss marks it failed and the next cron fire is the recovery.) */
  readonly maxRetries = 0;

  /** Single source of truth for the adapter's payload validation. */
  readonly payloadSchema = ReaperJobPayloadSchema;

  async handle(_payload: ReaperJobPayload, ctx: JobContext): Promise<void> {
    const log: ReapLogger = {
      info: (msg, meta) => ctx.log.info(msg, meta),
      warn: (msg, meta) => ctx.log.warn(msg, meta),
      error: (msg, meta) => ctx.log.error(msg, meta),
    };

    ctx.log.info('reaper tick: deleting expired rows');
    const { results, totalDeleted, failures } = await reapExpiredRows(log);

    // Per-table counts only — no row content, no PII (see reapExpiredRows).
    const perTable = results.map((r) => ({ table: r.table, deleted: r.deleted }));
    ctx.log.info('reaper tick complete', { totalDeleted, failures, perTable });

    if (failures > 0 && failures === results.length) {
      // EVERY target failed — systemic (pool/role). Throw so pg-boss
      // records the failure; the next hourly tick is the recovery path.
      throw new Error(`reaper: all ${failures} targets failed`);
    }
    if (failures > 0) {
      ctx.log.warn('reaper tick had partial failures (next tick will retry)', { failures });
    }
  }
}
