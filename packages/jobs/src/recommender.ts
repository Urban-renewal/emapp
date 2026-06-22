/**
 * `IRecommender` — the drop-in contract every autonomy recommender implements
 * (Autonomous Master Plan, design correction 2C/3B + the MEDIUM "define
 * IRecommender + a generic ProposalProducer" pin).
 *
 * A recommender's ONLY job is DETECTION: given a tick context it returns a set
 * of `DetectedCondition`s — each a fully-resolved description of "a thing the
 * system noticed that may warrant a proposal." It does NOT insert proposals, does
 * NOT send, does NOT decide policy. The generic `ProposalProducer` maps each
 * detected condition onto `emitProposal()` with a uniform dedup-key contract, so
 * a NEW autonomous behavior is "write another recommender" — never bespoke wiring.
 *
 * This file lives in `@emapp/jobs` and imports ONLY the autonomy-policy taxonomy
 * (which imports only zod), so it is dependency-light and FE-safe. The CONCRETE
 * recommenders + the producer that runs them live in `@emapp/db` (they need DB
 * access — detection is a query), mirroring how `signature-expiry-sweep.ts` owns
 * the sweep logic while the worker handler is the thin queue seam.
 *
 * Three first-class flavors are anticipated (the master-plan pin): periodic-scan,
 * event-triggered-single-shot, batch-fan-out. They all produce the same
 * `DetectedCondition` shape; the flavor only changes WHAT triggers `detect()`.
 */
import type { AutonomyActionKind } from './autonomy-policy';

/**
 * A single thing a recommender detected that may become a proposal. Everything
 * the producer needs to call `emitProposal` is here — the recommender has
 * already resolved the org, the target, the evidence snapshot, and the
 * deterministic dedup key.
 *
 * INVARIANTS the recommender MUST uphold:
 *  - `evidence` is PII-FREE (ids/counts/timestamps only — never national_id /
 *    phone / name). The producer stores it verbatim; it does not scrub.
 *  - `dedupKey` is DETERMINISTIC for the condition: the SAME underlying
 *    condition on two ticks yields the SAME key, so the partial-unique on
 *    `proposals(org_id, dedup_key) WHERE pending` makes the second emit a no-op.
 *    Include the entity id + the condition discriminator (e.g.
 *    `signature_request.reissue:<requestId>`), NOT a timestamp/nonce.
 */
export interface DetectedCondition {
  /** The org this condition belongs to (the producer writes per-tenant). */
  orgId: string;
  /** The AutonomyPolicy action kind the resulting proposal carries. */
  kind: AutonomyActionKind;
  /** What the proposal is about ('signature_request' | 'project' | …). */
  scopeType: string;
  /** The concrete in-org entity id the proposal targets. */
  scopeId: string;
  /** PII-free evidence snapshot (ids/counts/timestamps), stored verbatim at emit. */
  evidence: Record<string, unknown>;
  /** Deterministic idempotency key for this condition (no timestamp/nonce). */
  dedupKey: string;
  /** Optional retirement time for the resulting pending proposal. */
  expiresAt?: Date | null;
}

/**
 * The context handed to `detect()`. Deliberately minimal in Phase 1 (the wall
 * clock, so detection windows are testable with an injected `now`). Later
 * flavors extend it (e.g. an event payload for the event-triggered flavor)
 * WITHOUT changing this interface — add optional fields, never break detect().
 */
export interface RecommenderContext {
  /** The tick's reference time. Injected so set-based windows are deterministic. */
  now: Date;
}

/**
 * The drop-in interface. `id` namespaces the recommender (for logs/metrics +
 * per-producer isolation in the multi-producer tick). `detect` is pure-ish: it
 * reads (a set-based query in the DB impls) and returns conditions; it has NO
 * side effects on the proposal table — emitting is the producer's job.
 */
export interface IRecommender {
  /** Stable id for logs / per-producer isolation (e.g. 'signature-reissue'). */
  readonly id: string;
  /** Detect the conditions worth proposing. Set-based; no per-org loop. */
  detect(ctx: RecommenderContext): Promise<DetectedCondition[]>;
}
