/**
 * `SignatureStalledRecommender` — the PERCEPTION-driven, PROJECT-level stalled
 * recommender (Autonomous Managing System, wave 1.3 — the ANTICIPATE leg on the
 * just-merged `ProjectPerception` read-model).
 *
 * THE CONDITION: a NON-TERMINAL project that has gone QUIET — it still has
 * `signatures.pending > 0` (owners who have not signed) AND its oldest pending
 * signature request has been waiting `activity.oldestPendingAgeDays >= threshold`
 * (default 14d, the canonical `PERCEPTION_STALLED_DAYS`) — and no reminder is
 * currently in flight for it. Such a project is real, actionable signal: the
 * collection has stalled and the manager should nudge the holdouts. Each stalled
 * project becomes ONE `reminder.send` proposal at the PROJECT scope: "החתמת
 * הבעלים בפרויקט נתקעה — מוצע לשלוח תזכורת".
 *
 * ── ONE SOURCE OF TRUTH — reads the perception's signature facts (1.1) ───────
 * Detection is NOT re-coded here. It reads the canonical, SET-BASED
 * `detectProjectSignatureActivity` rows — the SCALABLE fleet-wide projection of
 * the `ProjectPerception` signature/activity facts: `pending` (=
 * `signatures.pending`), `oldestPendingAgeDays` (= `activity.oldestPendingAgeDays`),
 * via the SAME `projectSignatureDocIdsSql` doc-scope + the SAME age derive the
 * wave-1.1 assembler uses. The pending count, the oldest-pending age, the stalled
 * threshold (`PERCEPTION_STALLED_DAYS`), and the terminal/archived exclusion ALL
 * come from that canonical seam — the SAME facts the home KPI and the boards read.
 * No second signature query, no second age computation; a re-skin of the board's
 * numbers and this stalled signal can never drift. (The detection already EXCLUDES
 * terminal + archived projects, so this recommender inherits that for free.)
 *
 * ── Distinct from the per-request reminder-cadence recommender ───────────────
 * The `ReminderCadenceRecommender` proposes `reminder.send` at the
 * `signature_request` scope, driven by the per-request cadence clock in the
 * outbound_ledger (+3/+7/+14d, max 3). THIS recommender is a DIFFERENT, coarser
 * signal: a PROJECT that has gone quiet at all (perception-level). The two carry
 * the SAME kind but DIFFERENT scopeType (`project` vs `signature_request`) and a
 * DISTINCT dedup prefix, so they never collide; the inbox can surface "this whole
 * project stalled" independently of any single owner's reminder step.
 *
 * ── Idempotency + the "no reminder this window" guard (the dedup-key contract) ─
 * `dedupKey = 'reminder.send:project-stalled:<projectId>'` — DETERMINISTIC per
 * project; no timestamp/nonce. The partial-unique on
 * `proposals(org_id, dedup_key) WHERE pending` IS the "no reminder emitted this
 * window" guard: while a stalled-reminder proposal for this project is LIVE
 * (pending), a re-detection on the next tick is a NO-OP — the system does not
 * re-nag. Once the manager approves/rejects it (or it hits its TTL), the key
 * releases, so a project that is STILL stalled on a later tick re-surfaces ONE
 * fresh proposal. The proposal scope is `project`; the executor resolves the
 * holdout recipients + routes the actual send through `governOutboundSend` with
 * the REAL recipient consent (NEVER a hardcoded `recipientConsented:true`, the
 * #516 consent-bypass) — this recommender PROPOSES ONLY.
 *
 * ── Classification (AutonomyPolicy) ─────────────────────────────────────────
 * `reminder.send` classifies as `proposeConfirm` — OUTBOUND ⇒ NEVER auto-execute
 * (THE ONE BOUNDARY). The producer DRAFTS it; the manager confirms one-click.
 *
 * NO PII: the evidence snapshot carries the project id + the pending count + the
 * oldest-pending age + the threshold only — never owner national_id/phone/name
 * (the assembler is provably PII-free; this recommender adds no PII column).
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';

import { PERCEPTION_STALLED_DAYS } from '../perception/project-lifecycle.detect';

import { detectProjectSignatureActivity } from './signature-activity.detect';

/** The kind the produced proposals carry (classified outbound + consent →
 *  proposeConfirm; NEVER auto-execute). */
export const SIGNATURE_STALLED_KIND = 'reminder.send' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const SIGNATURE_STALLED_RECOMMENDER_ID = 'signature-stalled' as const;

/** The stalled age threshold (days). Defaults to the canonical
 *  `PERCEPTION_STALLED_DAYS` — the SAME threshold the assembler uses to derive
 *  `atRisk`, so the stalled signal and the perception's own risk flag stay
 *  lock-step (one source). Overridable for tests. */
export const SIGNATURE_STALLED_AGE_DAYS = PERCEPTION_STALLED_DAYS;

/** Default proposal TTL: a stalled-reminder proposal the manager never touches
 *  retires after 7 days (a stale reminder loses relevance fast; mirrors the
 *  reminder-cadence TTL). The project (if still stalled) re-surfaces on a later
 *  tick once the key releases. */
export const SIGNATURE_STALLED_PROPOSAL_TTL_DAYS = 7;

export interface SignatureStalledRecommenderOptions {
  stalledAgeDays?: number;
  proposalTtlDays?: number;
}

/**
 * Build the signature-stalled recommender. Pure detection — it READS the
 * canonical perception read-model and maps each stalled project to one OUTBOUND
 * reminder condition. The generic ProposalProducer does the per-tenant emit; the
 * executor does the governed send on the manager's one-click APPROVE.
 */
export function createSignatureStalledRecommender(
  opts: SignatureStalledRecommenderOptions = {},
): IRecommender {
  const stalledAgeDays = opts.stalledAgeDays ?? SIGNATURE_STALLED_AGE_DAYS;
  const proposalTtlDays = opts.proposalTtlDays ?? SIGNATURE_STALLED_PROPOSAL_TTL_DAYS;

  return {
    id: SIGNATURE_STALLED_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const expiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);

      // Read the canonical signature-activity projection across all orgs — the
      // SINGLE source of truth for pending/oldest-pending. No second query; the
      // detection already excluded terminal + archived projects.
      const activity = await detectProjectSignatureActivity(ctx.now);

      const conditions: DetectedCondition[] = [];
      for (const p of activity) {
        const pending = p.pending;
        const age = p.oldestPendingAgeDays;

        // STALLED iff there is at least one pending signature AND the oldest
        // pending request has been waiting at least the threshold. Both facts come
        // straight from the canonical seam — no re-computation here.
        if (pending <= 0) continue;
        if (age === null || age < stalledAgeDays) continue;

        conditions.push({
          orgId: p.orgId,
          kind: SIGNATURE_STALLED_KIND,
          scopeType: 'project',
          scopeId: p.projectId,
          // PII-FREE evidence snapshot: project + counts + age + threshold. A
          // human-readable reason string lets the FE render the user-framed copy
          // without any further lookup. NO owner PII.
          evidence: {
            condition: 'signature_stalled',
            projectId: p.projectId,
            pendingSignatures: pending,
            oldestPendingAgeDays: age,
            stalledThresholdDays: stalledAgeDays,
            reason: `${pending} בעלים טרם חתמו; הבקשה הוותיקה ממתינה ${age} ימים (סף ${stalledAgeDays})`,
          },
          // DETERMINISTIC dedup key per project — no timestamp/nonce. The
          // partial-unique-while-pending IS the "no reminder this window" guard.
          // Distinct prefix + scopeType from the per-request reminder-cadence key
          // so the project-level signal and the per-request cadence can coexist.
          dedupKey: `${SIGNATURE_STALLED_KIND}:project-stalled:${p.projectId}`,
          expiresAt,
        });
      }

      return conditions;
    },
  };
}
