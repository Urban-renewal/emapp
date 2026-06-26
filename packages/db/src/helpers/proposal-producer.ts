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
import { classify, type AutonomyActionKind } from '@emapp/jobs/autonomy-policy';
import { and, eq } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service';
import { providerPool } from '../client';
import { proposals, type Proposal } from '../schema/proposals';
import type { TenantTx } from '../wrappers/with-tenant';
import { withTenant } from '../wrappers/with-tenant';

import {
  applyProposalEffect,
  AUTO_EXECUTE_SAFE_KINDS,
} from './proposal-effects/apply-proposal-effect';
import { emitProposal } from './proposals';

/**
 * The AUTO-EXECUTE GRADUATION policy handed to a producer tick (Autonomous Master
 * Plan wave 1.2). `enabledKinds` is the per-kind OPT-IN allowlist (default EMPTY =
 * OFF: nothing auto-executes, every proposal still goes to the inbox — behaviour
 * identical to before wave 1.2). The worker handler resolves it from
 * `AUTO_EXECUTE_ENABLED_KINDS`; tests inject it directly. A kind auto-executes ONLY
 * if it is in BOTH `enabledKinds` AND the hard `AUTO_EXECUTE_SAFE_KINDS` allowlist
 * AND classify()==='autoExecute' (re-asserted by `applyProposalEffect` at execute) —
 * three independent gates, so listing an outbound/PII/floor kind here can never
 * promote it. */
export interface AutoExecutePolicy {
  enabledKinds: ReadonlySet<string>;
}

/** Default policy: OFF — nothing graduates. */
const AUTO_EXECUTE_OFF: AutoExecutePolicy = { enabledKinds: new Set<string>() };

/** Parse the `AUTO_EXECUTE_ENABLED_KINDS` comma-separated env value into a policy.
 *  Trims + drops empties so '' / ' ' / 'a, ,b' are handled. Default OFF. */
export function autoExecutePolicyFromEnv(raw: string | undefined): AutoExecutePolicy {
  const kinds = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { enabledKinds: new Set(kinds) };
}

/**
 * Decide whether a freshly-emitted proposal of `kind` is eligible to AUTO-EXECUTE.
 * THREE independent gates, ALL required (defense in depth):
 *   1. the per-kind OPT-IN flag is ON for this kind (default OFF), AND
 *   2. the kind is in the hard `AUTO_EXECUTE_SAFE_KINDS` allowlist (it has a
 *      registered DI-free auto-safe effect), AND
 *   3. classify(kind).decision === 'autoExecute' (the boundary — re-asserted here
 *      AND again inside `applyProposalEffect`, the non-bypassable backstop).
 * Any outbound/PII/floor kind fails gate 2 and gate 3 even if mis-listed in the flag.
 */
export function isAutoExecuteEligible(kind: string, policy: AutoExecutePolicy): boolean {
  if (!policy.enabledKinds.has(kind)) return false;
  if (!(AUTO_EXECUTE_SAFE_KINDS as readonly string[]).includes(kind)) return false;
  let decision: string;
  try {
    decision = classify({ kind: kind as AutonomyActionKind }).decision;
  } catch {
    return false; // unknown kind → fail closed
  }
  return decision === 'autoExecute';
}

/**
 * A stable, arbitrary 64-bit key for the producer's TICK NON-REENTRANCY advisory
 * lock (design correction "tick non-reentrancy"). Two ticks of the proposal
 * producer must never run concurrently — an overlapping tick would re-detect the
 * same conditions and (while idempotent via the dedup key + the M1 ledger key)
 * waste work and, worse, race the OutboundGovernor's claim window. The lock makes
 * a double-tick a clean SKIP. The number is just a unique app-chosen constant.
 */
export const PROPOSAL_PRODUCER_ADVISORY_LOCK_KEY = 4815162342 as const;

export interface GuardedTickResult {
  /** false when a prior tick still held the lock — this tick was SKIPPED. */
  ran: boolean;
  result?: ProposalProducerTickResult;
}

/**
 * Run one producer tick UNDER a session-level advisory lock so two overlapping
 * ticks can never double-draft (tick non-reentrancy). Uses `pg_try_advisory_lock`
 * (non-blocking): if another tick holds it, this one SKIPS cleanly (`ran:false`)
 * rather than queueing. The lock is held on a dedicated `providerPool` connection
 * for the tick's duration and released in `finally` (also auto-released if the
 * connection drops). This composes with the dedup key (draft-time) + the M1
 * ledger key (send-time) — defense in depth against double-propose → double-send.
 */
export async function runProposalProducerTickGuarded(
  recommenders: IRecommender[],
  ctx: RecommenderContext,
  log: ProducerLogger = NOOP_LOGGER,
  autoExecute: AutoExecutePolicy = AUTO_EXECUTE_OFF,
): Promise<GuardedTickResult> {
  const client = await providerPool.connect();
  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [PROPOSAL_PRODUCER_ADVISORY_LOCK_KEY],
    );
    if (!locked.rows[0]?.locked) {
      log.warn('proposal producer tick skipped — prior tick still running (advisory lock held)');
      return { ran: false };
    }
    try {
      const result = await runProposalProducerTick(recommenders, ctx, log, autoExecute);
      return { ran: true, result };
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [PROPOSAL_PRODUCER_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

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
  /** NEW proposals that were AUTO-EXECUTED this tick (graduated: flag-on +
   *  autoExecute-safe). Subset of `emitted`. 0 when the flag is OFF (default). */
  autoApplied: number;
  /** Emitted proposals eligible for auto-execute whose auto-apply threw (the proposal
   *  stays PENDING in the inbox — fail-safe, the graduation never blocks the draft). */
  autoApplyFailed: number;
  /** true when `detect()` itself threw — the whole recommender was skipped. */
  detectFailed: boolean;
}

export interface ProposalProducerTickResult {
  results: RecommenderRunResult[];
  /** Total NEW proposals across all recommenders this tick. */
  totalEmitted: number;
  /** Total proposals AUTO-EXECUTED this tick (0 when the flag is OFF). */
  totalAutoApplied: number;
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
  autoExecute: AutoExecutePolicy = AUTO_EXECUTE_OFF,
): Promise<ProposalProducerTickResult> {
  const results: RecommenderRunResult[] = [];

  for (const recommender of recommenders) {
    const result: RecommenderRunResult = {
      recommenderId: recommender.id,
      emitted: 0,
      deduped: 0,
      failed: 0,
      autoApplied: 0,
      autoApplyFailed: 0,
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
      // Whether this kind may graduate is decided ONCE, up front (cheap, no DB):
      // flag-on ∧ in AUTO_EXECUTE_SAFE_KINDS ∧ classify==='autoExecute'.
      const eligible = isAutoExecuteEligible(condition.kind, autoExecute);
      try {
        // Per-tenant emit + (eligible) auto-apply — the ONLY necessarily-scoped step.
        // Emit and graduation share ONE withTenant tx so the insert + effect + flip
        // are ATOMIC (a failed flip rolls back the effect; no half-apply).
        const { inserted, autoApplied } = await withTenant(condition.orgId, async (tx) => {
          const emit = await emitProposal(tx, {
            orgId: condition.orgId,
            kind: condition.kind,
            scopeType: condition.scopeType,
            scopeId: condition.scopeId,
            evidence: condition.evidence,
            dedupKey: condition.dedupKey,
            expiresAt: condition.expiresAt ?? null,
          });
          // Graduate ONLY a freshly-INSERTED eligible proposal (never a dedup no-op —
          // that proposal already exists and may already be applied/pending).
          if (emit.inserted && emit.proposal && eligible) {
            await autoApplyGraduatedProposal(
              tx,
              condition.kind as AutonomyActionKind,
              emit.proposal,
            );
            return { inserted: true, autoApplied: true };
          }
          return { inserted: emit.inserted, autoApplied: false };
        });
        if (inserted) result.emitted += 1;
        else result.deduped += 1;
        if (autoApplied) result.autoApplied += 1;
      } catch (err) {
        // Per-condition isolation: one bad emit/auto-apply doesn't drop the rest. An
        // auto-apply failure rolls back the WHOLE tx (the proposal is NOT inserted
        // either), so the next tick re-detects + re-emits the condition as a normal
        // pending proposal (fail-safe: graduation never silently loses the draft).
        result.failed += 1;
        if (eligible) result.autoApplyFailed += 1;
        log.error('proposal emit/auto-apply failed', {
          recommenderId: recommender.id,
          kind: condition.kind,
          eligible,
          err: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    log.info('proposal recommender tick complete', {
      recommenderId: recommender.id,
      emitted: result.emitted,
      deduped: result.deduped,
      failed: result.failed,
      autoApplied: result.autoApplied,
      autoApplyFailed: result.autoApplyFailed,
    });
    results.push(result);
  }

  const totalEmitted = results.reduce((sum, r) => sum + r.emitted, 0);
  const totalAutoApplied = results.reduce((sum, r) => sum + r.autoApplied, 0);
  return { results, totalEmitted, totalAutoApplied };
}

/**
 * AUTO-EXECUTE a freshly-emitted, eligible proposal — the graduation. MIRRORS the
 * manager-approve step exactly (proposals.service.ts `applyAutoSafeEffectAndFlip`),
 * minus the human: the SAME DI-free `applyProposalEffect` runs, then the proposal
 * flips `pending→applied`, then a `system`-attributed transition audit row is written
 * — all in the caller's ONE tx (so effect + flip are atomic).
 *
 * The actor-context is PURE SYSTEM: `createdBy: null` (an autonomous task has no human
 * author) + a null-actor audit context (no request ip/ua/session). `AuditService`
 * treats a null actor as a system action. NO PII — only ids + a taxonomy title reach
 * the row + audit.
 *
 * SECURITY: `applyProposalEffect` re-asserts the boundary internally (throws on any
 * non-autoExecute kind), so even if `isAutoExecuteEligible` were ever bypassed, no
 * outbound/PII/floor kind can mutate here. The effect's idempotency (the system-task
 * partial-unique) makes a producer↔approve race a no-op, not a double-apply.
 */
export async function autoApplyGraduatedProposal(
  tx: TenantTx,
  kind: AutonomyActionKind,
  proposal: Proposal,
): Promise<void> {
  // The effect — re-asserts the boundary (fail-closed on any non-autoExecute kind).
  // Pure-system actor-context: no human author, no request forensics.
  await applyProposalEffect(tx, kind, proposal, {
    createdBy: null,
    audit: { actorId: null },
  });

  // Flip → applied (race-safe `WHERE status='pending'`). On a lost race the whole tx
  // rolls back (effect included) and the condition re-emits next tick.
  const [row] = await tx
    .update(proposals)
    .set({ status: 'applied', appliedAt: new Date() })
    .where(and(eq(proposals.id, proposal.id), eq(proposals.status, 'pending')))
    .returning({ id: proposals.id, kind: proposals.kind });
  if (!row) {
    throw new Error('proposal_not_pending_at_auto_apply');
  }

  // System-attributed transition audit (actorId null = pure-system act) carrying the
  // proposal id + kind — every autonomous act is audited, exactly like approve.
  await new AuditService(tx).log({
    orgId: proposal.orgId,
    actorType: 'system',
    action: 'proposal.auto_execute',
    targetTable: 'proposals',
    targetId: row.id,
    metadata: { kind: row.kind, trigger: 'producer_auto_execute' },
  });
}
