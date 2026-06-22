/**
 * `ProposalProducer` — the generic engine that turns recommenders' detected
 * conditions into proposals (Autonomous Master Plan, design corrections 2C/3B +
 * H-error per-producer isolation + H-runtime set-based detection).
 *
 * One producer runs a LIST of `IRecommender`s on each tick. For each recommender:
 *   1. `detect(ctx)` runs ONCE (set-based — the recommender's query spans all
 *      orgs; never a per-org loop).
 *   2. Each `DetectedCondition` is emitted via `emitProposal` inside a
 *      `withTenant(orgId, …)` tx — the only necessarily-per-tenant step (the
 *      write must be RLS-scoped). The dedup-key contract makes a re-detected
 *      condition a no-op, so re-running every tick is safe and cheap.
 *
 * PER-PRODUCER FAILURE ISOLATION (design correction H-error): each recommender
 * runs in its OWN try/catch. One recommender throwing (a bad query, a transient
 * DB error) NEVER drops the other recommenders' proposals; the failure is
 * logged + reported and the loop continues. A recommender that missed its tick
 * recovers on its OWN next tick (detection is idempotent via the dedup key).
 *
 * The producer is deliberately thin + reusable: the worker handler is the queue
 * seam (cron + payload), this is the orchestration, and each recommender owns its
 * detection. Adding a behavior = registering another recommender here — no new
 * engine part (Q2/Q3 of the gate table).
 *
 * OBSERVABILITY (Q6): the producer returns a per-recommender result summary
 * `{ emitted, deduped, failed }` so the handler can log a correlatable line +
 * metric per tick — a missed/failed recommender is diagnosable, not silent.
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';

import { withTenant } from '../wrappers/with-tenant';

import { emitProposal } from './proposals';

export interface ProducerLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Per-recommender outcome for one tick (counts only — no PII, no ids). */
export interface RecommenderRunResult {
  recommenderId: string;
  /** Conditions that produced a NEW pending proposal. */
  emitted: number;
  /** Conditions whose emit was an idempotent no-op (already live). */
  deduped: number;
  /** Conditions whose emit threw (per-condition isolation within a recommender). */
  failed: number;
  /** true when `detect()` itself threw — the whole recommender was skipped. */
  detectFailed: boolean;
}

export interface ProposalProducerTickResult {
  results: RecommenderRunResult[];
  /** Total NEW proposals across all recommenders this tick. */
  totalEmitted: number;
}

const NOOP_LOGGER: ProducerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Run one tick of the producer over its recommenders. Never throws for a single
 * recommender/condition failure (isolation); only a catastrophic bug would
 * escape. Returns the per-recommender summary for the handler to log.
 */
export async function runProposalProducerTick(
  recommenders: IRecommender[],
  ctx: RecommenderContext,
  log: ProducerLogger = NOOP_LOGGER,
): Promise<ProposalProducerTickResult> {
  const results: RecommenderRunResult[] = [];

  for (const recommender of recommenders) {
    const result: RecommenderRunResult = {
      recommenderId: recommender.id,
      emitted: 0,
      deduped: 0,
      failed: 0,
      detectFailed: false,
    };

    let conditions: DetectedCondition[] = [];
    try {
      // Set-based detection — ONE query across all orgs (H-runtime).
      conditions = await recommender.detect(ctx);
    } catch (err) {
      // Per-producer isolation: a detect() failure skips THIS recommender only.
      result.detectFailed = true;
      log.error('proposal recommender detect failed', {
        recommenderId: recommender.id,
        err: err instanceof Error ? err.message : 'unknown',
      });
      results.push(result);
      continue;
    }

    for (const condition of conditions) {
      try {
        // Per-tenant emit — the only necessarily-scoped step. RLS-isolated.
        const { inserted } = await withTenant(condition.orgId, (tx) =>
          emitProposal(tx, {
            orgId: condition.orgId,
            kind: condition.kind,
            scopeType: condition.scopeType,
            scopeId: condition.scopeId,
            evidence: condition.evidence,
            dedupKey: condition.dedupKey,
            expiresAt: condition.expiresAt ?? null,
          }),
        );
        if (inserted) result.emitted += 1;
        else result.deduped += 1;
      } catch (err) {
        // Per-condition isolation: one bad emit doesn't drop the rest.
        result.failed += 1;
        log.error('proposal emit failed', {
          recommenderId: recommender.id,
          kind: condition.kind,
          err: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    log.info('proposal recommender tick complete', {
      recommenderId: recommender.id,
      emitted: result.emitted,
      deduped: result.deduped,
      failed: result.failed,
    });
    results.push(result);
  }

  const totalEmitted = results.reduce((sum, r) => sum + r.emitted, 0);
  return { results, totalEmitted };
}
