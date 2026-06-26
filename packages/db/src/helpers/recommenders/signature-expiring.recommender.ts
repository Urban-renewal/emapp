/**
 * `SignatureExpiringRecommender` — the PERCEPTION-driven ANTICIPATE recommender
 * for signature requests about to LAPSE (Autonomous Managing System, wave 1.3 —
 * reads the just-merged `ProjectPerception` read-model).
 *
 * THE CONDITION: a NON-TERMINAL project whose NEXT pending signature request is
 * lapsing SOON — `activity.nextExpiryAt` falls within the look-ahead window
 * (default <7 days from now) and is still in the FUTURE (not already expired).
 * Such a request is about to die silently; rather than let it expire and then
 * re-mint (the AFTER-the-fact path the per-request `signature-reissue` recommender
 * covers), this ANTICIPATES the lapse and PROPOSES re-issuing a fresh signing link
 * BEFORE it expires, so the owner is never left holding a dead link.
 *
 * ── ONE SOURCE OF TRUTH — reads the perception's next-expiry fact (1.1) ──────
 * The imminent-expiry fact comes straight from the canonical, SET-BASED
 * `detectProjectSignatureActivity` `nextExpiryAt` — the SCALABLE fleet-wide
 * projection of the wave-1.1 assembler's `activity.nextExpiryAt` (`MIN(expires_at)`
 * over the project's PENDING requests on the SAME `projectSignatureDocIdsSql`
 * doc-scope). No second expiry query, no second doc-scope resolution — the SAME
 * `nextExpiryAt` the boards/perception read. The detection already EXCLUDES
 * terminal + archived projects, so this recommender inherits that for free.
 *
 * ── Distinct from the per-request `signature-reissue` recommender ────────────
 * `SignatureReissueRecommender` fires AFTER a request has flipped to `expired`
 * (the hourly sweep set it) and re-mints the LAPSED link — recovery. THIS fires
 * BEFORE the lapse (perception-level `nextExpiryAt < window`) — prevention. They
 * carry the SAME kind (`signature_request.reissue`) but a DISTINCT dedup prefix
 * and a different scope (`project` vs `signature_request`), so the anticipate and
 * the recover paths never collide; together they bracket the expiry moment.
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'signature_request.reissue:project-expiring:<projectId>:<expiryDay>'`
 * — DETERMINISTIC per (project, the lapsing expiry DAY); no timestamp/nonce. The
 * partial-unique on `proposals(org_id, dedup_key) WHERE pending` makes a
 * re-detection of the SAME imminent expiry a NO-OP while the proposal is live; the
 * expiry-DAY bucket means a DIFFERENT (later) imminent expiry — after this one is
 * handled and a new nearest-pending takes over — re-proposes legitimately, while
 * the same nearest-expiry on consecutive ticks does not double-emit. Once
 * approved/rejected the key releases.
 *
 * ── Classification (AutonomyPolicy) ─────────────────────────────────────────
 * `signature_request.reissue` is INTERNAL + reversible + non-PII, so by THE ONE
 * BOUNDARY it is autoExecute-ELIGIBLE — but, like every wave-1 producer, this
 * ships PROPOSE-AND-CONFIRM: the producer DRAFTS it and the executor only re-mints
 * on the manager's one-click APPROVE (the existing `reissueAndDeliver` path; this
 * recommender does NOT re-split it into a send-free variant). This recommender
 * PROPOSES ONLY — no auto-execute.
 *
 * NO PII: the evidence snapshot carries the project id + the next-expiry timestamp
 * + the days-until-expiry + the window only — never owner national_id/phone/name
 * (the assembler is provably PII-free; this recommender adds no PII column).
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';

import { detectProjectSignatureActivity } from './signature-activity.detect';

/** The kind the produced proposals carry (classified internal+reversible+non-PII;
 *  PROPOSE-AND-CONFIRM in wave 1, never auto-executed here). */
export const SIGNATURE_EXPIRING_KIND = 'signature_request.reissue' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const SIGNATURE_EXPIRING_RECOMMENDER_ID = 'signature-expiring' as const;

/** Look-ahead window (days): a project whose next pending request lapses within
 *  this many days (and is still in the future) is proposed for re-issue. */
export const SIGNATURE_EXPIRING_WINDOW_DAYS = 7;

/** Default proposal TTL: an expiring-soon proposal the manager never touches
 *  retires after 7 days so the inbox stays calm; if the request lapses anyway the
 *  recover-path `signature-reissue` recommender picks it up. */
export const SIGNATURE_EXPIRING_PROPOSAL_TTL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SignatureExpiringRecommenderOptions {
  windowDays?: number;
  proposalTtlDays?: number;
}

/**
 * Build the signature-expiring recommender. Pure detection — it READS the
 * canonical perception read-model and maps each project with an imminent pending
 * expiry to one reissue condition. The generic ProposalProducer does the
 * per-tenant emit; the executor re-mints on the manager's one-click APPROVE.
 */
export function createSignatureExpiringRecommender(
  opts: SignatureExpiringRecommenderOptions = {},
): IRecommender {
  const windowDays = opts.windowDays ?? SIGNATURE_EXPIRING_WINDOW_DAYS;
  const proposalTtlDays = opts.proposalTtlDays ?? SIGNATURE_EXPIRING_PROPOSAL_TTL_DAYS;

  return {
    id: SIGNATURE_EXPIRING_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const now = ctx.now.getTime();
      const windowEnd = now + windowDays * DAY_MS;
      const proposalExpiresAt = new Date(now + proposalTtlDays * DAY_MS);

      // Read the canonical signature-activity projection across all orgs — the
      // SINGLE source of truth for the next-pending-expiry timestamp. No second
      // query; the detection already excluded terminal + archived projects.
      const activity = await detectProjectSignatureActivity(ctx.now);

      const conditions: DetectedCondition[] = [];
      for (const p of activity) {
        const nextExpiryIso = p.nextExpiryAt;
        if (nextExpiryIso === null) continue;

        const expiryMs = Date.parse(nextExpiryIso);
        if (Number.isNaN(expiryMs)) continue;

        // LAPSING SOON iff the next pending expiry is in the FUTURE (not already
        // expired — the recover-path recommender owns those) AND within the
        // look-ahead window. Both facts derive from the assembler's nextExpiryAt.
        if (expiryMs <= now) continue;
        if (expiryMs > windowEnd) continue;

        const daysUntilExpiry = Math.max(0, Math.ceil((expiryMs - now) / DAY_MS));
        // The expiry DAY bucket (UTC yyyy-mm-dd) — stable across ticks for the same
        // imminent expiry, so re-detection is a no-op; a later nearest-expiry on a
        // different day re-proposes.
        const expiryDay = new Date(expiryMs).toISOString().slice(0, 10);

        conditions.push({
          orgId: p.orgId,
          kind: SIGNATURE_EXPIRING_KIND,
          scopeType: 'project',
          scopeId: p.projectId,
          // PII-FREE evidence snapshot: project + next-expiry + days + window only.
          evidence: {
            condition: 'signature_expiring',
            projectId: p.projectId,
            nextExpiryAt: nextExpiryIso,
            daysUntilExpiry,
            windowDays,
            reason: `החתמה בפרויקט עומדת לפוג בעוד ${daysUntilExpiry} ימים — מוצע לחדש את הקישור`,
          },
          // DETERMINISTIC dedup key per (project, lapsing expiry DAY) — no
          // timestamp/nonce. Distinct prefix + scope from the per-request
          // recover-path key so anticipate + recover can coexist.
          dedupKey: `${SIGNATURE_EXPIRING_KIND}:project-expiring:${p.projectId}:${expiryDay}`,
          expiresAt: proposalExpiresAt,
        });
      }

      return conditions;
    },
  };
}
