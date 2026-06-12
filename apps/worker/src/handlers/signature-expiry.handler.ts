/**
 * `sweep:signature-expiry` handler — V12 slice-1 critic follow-up.
 *
 * The THIRD consumer of the periodic-runner infrastructure (after
 * `reaper:expired-rows` + `retention:audit-log`). pg-boss's cron
 * (`boss.schedule(SIGNATURE_EXPIRY_JOB_NAME, SIGNATURE_EXPIRY_CRON_HOURLY)`,
 * wired in main.ts) enqueues an empty-payload job hourly; this handler
 * flips lapsed pending signature_requests to 'expired' via
 * `sweepExpiredSignatureRequests` (in @emapp/db, which owns the
 * BYPASSRLS maintenance pool — see that module for the pool-choice
 * justification, the exact predicate, and the per-org system-audit
 * convention).
 *
 * Thin by design: the handler is the queue seam (name / timeout / retry
 * policy + a Zod-validated empty payload); the sweep LOGIC + its audit
 * writes live in @emapp/db so they are unit-testable without pg-boss and
 * reusable by any future trigger (e.g. an ops-invoked manual sweep).
 *
 * Error policy: the sweep is ONE atomic statement (UPDATE + per-org
 * audit INSERT as CTEs) — any failure throws, pg-boss records it, and
 * the next hourly tick is the recovery path (the predicate is
 * recomputed each run, so the job is idempotent across retries).
 *
 * NO PII / row content in logs: the completion line carries only the
 * integer flip count — no jti, no owner/document/request ids (the
 * reaper/retention no-PII convention).
 */
import { sweepExpiredSignatureRequests } from '@emapp/db';
import {
  SIGNATURE_EXPIRY_JOB_NAME,
  SignatureExpiryJobPayloadSchema,
  type IJobHandler,
  type JobContext,
  type SignatureExpiryJobPayload,
} from '@emapp/jobs';

export class SignatureExpiryHandler implements IJobHandler<SignatureExpiryJobPayload> {
  readonly name = SIGNATURE_EXPIRY_JOB_NAME;

  /** 2 minutes — one indexed bulk UPDATE + a handful of audit INSERTs
   *  completes in well under a second; the generous ceiling only guards
   *  against a pathological lock-wait. */
  readonly timeoutMs = 2 * 60 * 1000;

  /** No retries. The sweep is idempotent and runs hourly — a missed
   *  tick is swept by the next one, so re-queuing a failed tick adds
   *  load without benefit (same stance as the hourly reaper). */
  readonly maxRetries = 0;

  /** Single source of truth for the adapter's payload validation. */
  readonly payloadSchema = SignatureExpiryJobPayloadSchema;

  async handle(_payload: SignatureExpiryJobPayload, ctx: JobContext): Promise<void> {
    ctx.log.info('signature expiry sweep: flipping lapsed pending requests');

    const { expired, orgsAffected } = await sweepExpiredSignatureRequests();

    // Counts only — no row content, no jti, no owner/document ids, no PII.
    ctx.log.info('signature expiry sweep complete', { expired, orgsAffected });
  }
}
