/**
 * `produce:proposals` handler — Autonomous Master Plan, Phase 1.
 *
 * The FOURTH periodic consumer (after reaper / retention / signature-expiry).
 * pg-boss's cron enqueues an empty-payload job hourly (:45); this handler runs the
 * generic `runProposalProducerTick` over its registered recommenders. Phase 1
 * registers ONE: the signature-reissue recommender (expiry → re-issue proposal).
 *
 * Thin by design: the handler is the queue seam (name / timeout / retry + a
 * Zod-validated empty payload); the producer ORCHESTRATION + per-producer
 * isolation + the recommenders' set-based detection live in @emapp/db so they are
 * unit-testable without pg-boss and reusable by any future trigger.
 *
 * Error policy — TWO layers:
 *   - INNER (per-producer isolation, design correction H-error): the producer
 *     wraps each recommender + each emit in its own try/catch, so one failing
 *     recommender never drops the others. A failure logs + continues.
 *   - OUTER (maxRetries=0): a catastrophic tick failure throws; pg-boss records
 *     it; the next hourly tick is the recovery path (detection is idempotent via
 *     the dedup key — re-running re-detects the same conditions as no-ops).
 *
 * NO PII / row content in logs: only integer per-recommender counts (the
 * reaper/retention/expiry no-PII convention).
 */
import { createSignatureReissueRecommender, runProposalProducerTick } from '@emapp/db';
import {
  PROPOSAL_PRODUCER_JOB_NAME,
  ProposalProducerJobPayloadSchema,
  type IJobHandler,
  type IRecommender,
  type JobContext,
  type ProposalProducerJobPayload,
} from '@emapp/jobs';

export class ProposalProducerHandler implements IJobHandler<ProposalProducerJobPayload> {
  readonly name = PROPOSAL_PRODUCER_JOB_NAME;

  /** 5 minutes — set-based detection + a bounded fan-out of per-tenant emits.
   *  Generous ceiling guards only a pathological lock-wait. */
  readonly timeoutMs = 5 * 60 * 1000;

  /** No retries. The tick is idempotent (dedup-keyed) and runs hourly — a missed
   *  tick is recovered by the next one (same stance as the other sweeps). */
  readonly maxRetries = 0;

  readonly payloadSchema = ProposalProducerJobPayloadSchema;

  /** The recommenders this producer runs. Phase 1: just signature-reissue.
   *  Adding a behavior = registering another recommender here (drop-in). */
  private readonly recommenders: IRecommender[] = [createSignatureReissueRecommender()];

  async handle(_payload: ProposalProducerJobPayload, ctx: JobContext): Promise<void> {
    ctx.log.info('proposal producer tick: drafting proposals (no send, no auto-apply)');

    const { results, totalEmitted } = await runProposalProducerTick(
      this.recommenders,
      { now: new Date() },
      ctx.log,
    );

    // Counts only — no org/request/proposal ids, no PII.
    ctx.log.info('proposal producer tick complete', {
      totalEmitted,
      recommenders: results.map((r) => ({
        id: r.recommenderId,
        emitted: r.emitted,
        deduped: r.deduped,
        failed: r.failed,
        detectFailed: r.detectFailed,
      })),
    });
  }
}
