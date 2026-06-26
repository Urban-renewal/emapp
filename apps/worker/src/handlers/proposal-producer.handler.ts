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
import { serverEnv } from '@emapp/config';
import {
  autoExecutePolicyFromEnv,
  createDocumentChaseRecommender,
  createReminderCadenceRecommender,
  createSignatureReissueRecommender,
  createTaskWatcherRecommender,
  runProposalProducerTickGuarded,
} from '@emapp/db';
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

  /** The recommenders this producer runs. Each runs in its OWN try/catch inside
   *  `runProposalProducerTick` (design correction H-error: per-producer isolation
   *  — one throwing recommender never drops the others' proposals). Adding a
   *  behavior = registering another recommender here (drop-in):
   *    - signature-reissue (Phase 1): expiry → re-issue (internal, reversible).
   *    - reminder-cadence  (Phase 2): pending-no-response → reminder.send
   *      (governed outbound; APPROVE sends ONE reminder through the
   *      OutboundGovernor + the M1 exactly-once ledger).
   *    - task-watcher      (G1):      gathering-signatures project missing a
   *      required doc type → task.create (internal, reversible; APPROVE opens a
   *      SYSTEM-OWNED task via the existing gated tasks.create).
   *    - document-chase    (S5):      the SAME missing-required-doc gap → an
   *      OUTBOUND document.chase.send (chase the responsible party). Reuses the
   *      SHARED detectMissingRequiredDocs (no second query) + providerPartyForDocType;
   *      APPROVE routes the send through governOutboundSend (consent-gated). */
  private readonly recommenders: IRecommender[] = [
    createSignatureReissueRecommender(),
    createReminderCadenceRecommender(),
    createTaskWatcherRecommender(),
    createDocumentChaseRecommender(),
  ];

  async handle(_payload: ProposalProducerJobPayload, ctx: JobContext): Promise<void> {
    // AUTO-EXECUTE GRADUATION (wave 1.2) — the per-kind opt-in allowlist, default OFF.
    // With AUTO_EXECUTE_ENABLED_KINDS unset/empty NOTHING graduates: every proposal
    // still goes to the Approval Inbox (behaviour identical to before wave 1.2).
    const autoExecute = autoExecutePolicyFromEnv(serverEnv.AUTO_EXECUTE_ENABLED_KINDS);
    const autoExecuteOn = autoExecute.enabledKinds.size > 0;
    ctx.log.info(
      autoExecuteOn
        ? 'proposal producer tick: drafting proposals (auto-execute ON for safe kinds)'
        : 'proposal producer tick: drafting proposals (no send, no auto-apply)',
    );

    // TICK NON-REENTRANCY (design correction): a session advisory lock makes an
    // overlapping tick a clean SKIP rather than a double-draft (which would race
    // the OutboundGovernor's M1 claim window). The dedup key + ledger key already
    // make double-draft idempotent; the lock avoids the wasted work + the race.
    const { ran, result } = await runProposalProducerTickGuarded(
      this.recommenders,
      { now: new Date() },
      ctx.log,
      autoExecute,
    );

    if (!ran || !result) {
      ctx.log.info('proposal producer tick skipped — prior tick still running');
      return;
    }

    // Counts only — no org/request/proposal ids, no PII.
    ctx.log.info('proposal producer tick complete', {
      totalEmitted: result.totalEmitted,
      totalAutoApplied: result.totalAutoApplied,
      recommenders: result.results.map((r) => ({
        id: r.recommenderId,
        emitted: r.emitted,
        deduped: r.deduped,
        failed: r.failed,
        autoApplied: r.autoApplied,
        autoApplyFailed: r.autoApplyFailed,
        detectFailed: r.detectFailed,
      })),
    });
  }
}
