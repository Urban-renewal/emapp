/**
 * The `produce:proposals` job — Autonomous Master Plan, Phase 1.
 *
 * The FOURTH periodic consumer (after reaper / retention / signature-expiry).
 * On each tick the handler runs the generic ProposalProducer over its registered
 * recommenders (Phase 1: the signature-reissue recommender) — set-based
 * detection across all orgs, then a per-tenant idempotent `emitProposal`. It NEVER
 * sends and NEVER auto-applies; it only DRAFTS proposals into the Approval Inbox.
 *
 * NO payload — a pure tick. pg-boss's `schedule(name, cron)` enqueues an empty
 * `{}` each fire; the strict schema rejects a tampered enqueue carrying fields.
 */
import { z } from 'zod';

/** Job name registered with pg-boss. `produce:` namespace — it DRAFTS proposals
 *  (distinct from `sweep:`/`reaper:`/`retention:` which mutate/delete rows). */
export const PROPOSAL_PRODUCER_JOB_NAME = 'produce:proposals' as const;

/** Cron cadence — hourly at :45, offset from the reaper (:00) + audit-retention
 *  + signature-expiry (:30) so the four maintenance ticks never contend. The
 *  reissue recommender runs AFTER the :30 expiry sweep so freshly-expired
 *  requests are visible to it within the same hour. Evaluated by pg-boss in UTC. */
export const PROPOSAL_PRODUCER_CRON_HOURLY = '45 * * * *' as const;

/** Validated payload — the tick takes NO parameters (`.strict()` empty object). */
export const ProposalProducerJobPayloadSchema = z.object({}).strict();

export type ProposalProducerJobPayload = z.infer<typeof ProposalProducerJobPayloadSchema>;
