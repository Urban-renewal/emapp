/**
 * `retention:audit-log` handler — Roadmap P0.C3 (compliance retention).
 *
 * The SECOND consumer of the periodic-runner infrastructure (after
 * `reaper:expired-rows`), kept separate on purpose: this one enforces the
 * audit-log RETENTION FLOOR. pg-boss's cron (`boss.schedule(...)`, wired in
 * main.ts) enqueues an empty-payload job daily; this handler runs the
 * batched `audit_log` prune via `pruneAuditLog` (in @emapp/db, which owns
 * the BYPASSRLS maintenance pool + the ≥24-month floor-clamp).
 *
 * Thin by design: the handler is the queue seam (name / timeout / retry +
 * a Zod-validated empty payload); the retention LOGIC + the regulatory
 * floor live in @emapp/db so they are unit-testable without pg-boss and the
 * floor is enforced for every caller, not just this handler.
 *
 * Evidence/observability (the "evidenced policy" the reg wants): the
 * handler emits a structured log line with the EFFECTIVE retention window
 * (post floor-clamp) and the rows-deleted count each run, mirroring the
 * reaper's per-run summary. No PII / row content — only the window and
 * integer counts (audit_log rows carry national_id / IP / before-after
 * state, which are NEVER read or logged).
 *
 * Error policy: a structural failure (pool down / role lost BYPASSRLS)
 * THROWS so pg-boss records it; the job is idempotent (the cutoff is
 * recomputed each run) so the next daily tick is the recovery path. We allow
 * one retry — unlike the hourly reaper, a missed daily run is 24h of
 * unpruned growth, so a single quick retry is worth it.
 *
 * Immutability guard (P0.C3): `audit_log` is append-only via the
 * `trg_audit_log_immutable` trigger. As of migration 0060 (Gate-6) that
 * trigger is age-gated — it permits DELETE of rows past the 24-month floor
 * (which is exactly what the prune does) while still RAISING on every UPDATE
 * and on DELETE of any row inside the floor. In normal operation the prune's
 * DELETE simply succeeds. We KEEP recognising that specific immutability error
 * and logging it at WARN WITHOUT throwing — a belt-and-braces guard for the
 * now-impossible case where a prune ever presented an inside-floor row, so a
 * single such row could never spam pg-boss failures/retries. Every OTHER error
 * still throws (genuine infra failures must be visible + retried). See @emapp/db
 * audit-retention.ts and migration 0060.
 */
import { env, isAuditLogImmutableError, pruneAuditLog, type ReapLogger } from '@emapp/db';
import {
  AUDIT_RETENTION_JOB_NAME,
  AuditRetentionJobPayloadSchema,
  type IJobHandler,
  type JobContext,
  type AuditRetentionJobPayload,
} from '@emapp/jobs';

export class AuditRetentionHandler implements IJobHandler<AuditRetentionJobPayload> {
  readonly name = AUDIT_RETENTION_JOB_NAME;

  /** 10 minutes. The batched prune is a series of short transactions, but a
   *  first run against a large never-pruned backlog can take several batches;
   *  the generous ceiling guards a cold-start drain without thrashing. */
  readonly timeoutMs = 10 * 60 * 1000;

  /** One retry. The prune is idempotent (cutoff recomputed each run); a
   *  daily cadence means a missed run is a full day of unpruned growth, so a
   *  single quick retry on a transient is worthwhile (vs the hourly reaper's
   *  zero-retry, where the next tick is only an hour away). */
  readonly maxRetries = 1;

  /** Single source of truth for the adapter's payload validation. */
  readonly payloadSchema = AuditRetentionJobPayloadSchema;

  async handle(_payload: AuditRetentionJobPayload, ctx: JobContext): Promise<void> {
    const log: ReapLogger = {
      info: (msg, meta) => ctx.log.info(msg, meta),
      warn: (msg, meta) => ctx.log.warn(msg, meta),
      error: (msg, meta) => ctx.log.error(msg, meta),
    };

    ctx.log.info('audit retention tick: pruning audit_log past the retention window');

    try {
      // The raw configured window is read from config; the ≥24-month floor is
      // enforced inside pruneAuditLog → resolveRetentionMonths, so even a
      // misconfigured AUDIT_RETENTION_MONTHS=12 keeps 24 months.
      const result = await pruneAuditLog(log, {
        rawRetentionMonths: env.AUDIT_RETENTION_MONTHS,
      });

      // Evidence line — effective window + integer counts only (no PII).
      ctx.log.info('audit retention tick complete', {
        effectiveRetentionMonths: result.effectiveRetentionMonths,
        deleted: result.deleted,
        batches: result.batches,
        hitBatchCap: result.hitBatchCap,
      });
    } catch (e: unknown) {
      // Known, owner-pending blocker: the append-only immutability trigger
      // rejects the prune DELETE (drizzle wraps the pg error, so we check the
      // whole cause chain). Log at WARN and complete the job (no retry storm)
      // — no rows were touched. Re-throw any OTHER error so genuine infra
      // failures stay visible and get the one configured retry.
      if (isAuditLogImmutableError(e)) {
        ctx.log.warn(
          'audit retention prune BLOCKED by append-only trigger — awaiting Gate-6 carve-out migration (no rows mutated)',
          { blocked: true },
        );
        return;
      }
      throw e;
    }
  }
}
