/**
 * `permit-expiring` — wave-2.4 future-states autonomy recommender (permit-only
 * first cut). PROPOSE-ONLY.
 *
 * THE CONDITION: a LIVE (non-terminal, non-archived) project whose APPROVED
 * building permit (היתר בנייה) is within ~30 days of expiry — or has already
 * lapsed. An approved permit that expires before/during construction is real,
 * costly work the manager must chase (renew the permit), and today nothing
 * surfaces it. Each qualifying project becomes ONE `task.create` proposal:
 * "היתר עומד לפוג — חידוש".
 *
 * ── Reuse, not re-implement ─────────────────────────────────────────────────
 * Mirrors the G1 TaskWatcher exactly: a thin recommender over a SINGLE canonical
 * set-based detect helper (`detectExpiringPermits`), mapping each row to a
 * `task.create` DetectedCondition. NO new AutonomyActionKind — it reuses the
 * existing, classified `task.create` (internal + reversible + non-PII). The
 * generic ProposalProducer does the per-tenant emit + dedup; the OutboundGovernor
 * is not involved (internal task, no send).
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'task.create:permit-expiring:<projectId>:<expiryEpochMs>'` —
 * DETERMINISTIC per (project, the specific expiry instant); no timestamp/nonce.
 * Keying on the EXPIRY instant (not just the project) means: re-detecting the
 * SAME expiring permit on a later tick is a no-op while the proposal is live, BUT
 * if the manager RENEWS the permit (a new, later `permit_expiry_at`) and that new
 * date later enters the window, a FRESH proposal can surface — the renewed permit
 * is a genuinely new condition. The partial-unique on `proposals(org_id,
 * dedup_key) WHERE pending` enforces the no-op; once approved/rejected the key
 * releases so a gap that re-opens can re-propose.
 *
 * NO PII: the evidence snapshot carries the project id + status + expiry date +
 * the already-expired flag only — never owner national_id/phone/name.
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';

import { PERMIT_EXPIRING_WINDOW_DAYS, detectExpiringPermits } from './permit-expiring.detect';

/** The kind the produced proposals carry (classified internal+reversible+non-PII).
 *  Reuses the EXISTING task.create kind — no new AutonomyActionKind. */
export const PERMIT_EXPIRING_TASK_KIND = 'task.create' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const PERMIT_EXPIRING_RECOMMENDER_ID = 'permit-expiring' as const;

/** Default proposal TTL: an untouched permit-expiring proposal retires after 14
 *  days so the inbox stays calm; the condition (if still open) re-surfaces on a
 *  later tick once the key releases. */
export const PERMIT_EXPIRING_PROPOSAL_TTL_DAYS = 14;

export interface PermitExpiringRecommenderOptions {
  /** Override the warning window (days before expiry). Default 30. */
  windowDays?: number;
  proposalTtlDays?: number;
}

/**
 * Build the permit-expiring recommender. Pure detection — it reads live projects
 * with an approved permit near/past expiry and returns one condition per project;
 * the generic ProposalProducer does the per-tenant emit.
 */
export function createPermitExpiringRecommender(
  opts: PermitExpiringRecommenderOptions = {},
): IRecommender {
  const windowDays = opts.windowDays ?? PERMIT_EXPIRING_WINDOW_DAYS;
  const proposalTtlDays = opts.proposalTtlDays ?? PERMIT_EXPIRING_PROPOSAL_TTL_DAYS;

  return {
    id: PERMIT_EXPIRING_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const expiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);

      // ONE canonical set-based detection across all orgs (single source of truth).
      const rows = await detectExpiringPermits(ctx.now, windowDays);

      return rows.map((row): DetectedCondition => {
        const expiryEpochMs = new Date(row.permitExpiryAt).getTime();
        return {
          orgId: row.orgId,
          kind: PERMIT_EXPIRING_TASK_KIND,
          scopeType: 'project',
          scopeId: row.projectId,
          // PII-FREE evidence snapshot: project id + status + expiry + flag only.
          // The condition discriminator lets the executor compose a user-framed,
          // PII-free task title/body ("היתר עומד לפוג — חידוש") without a lookup.
          evidence: {
            condition: 'permit_expiring',
            projectId: row.projectId,
            projectStatus: row.projectStatus,
            permitExpiryAt: row.permitExpiryAt,
            alreadyExpired: row.alreadyExpired,
          },
          // DETERMINISTIC dedup key per (project, the specific expiry instant) —
          // no timestamp/nonce. A renewed permit (new expiry) is a new condition.
          dedupKey: `${PERMIT_EXPIRING_TASK_KIND}:permit-expiring:${row.projectId}:${expiryEpochMs}`,
          expiresAt,
        };
      });
    },
  };
}
