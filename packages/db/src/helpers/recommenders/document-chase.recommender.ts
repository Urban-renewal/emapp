/**
 * `DocumentChaseRecommender` — the S5 OUTBOUND document-chase recommender
 * (DOCUMENTS-PROCESS-DESIGN.md S5; Autonomous Master Plan L3 "the system CHASES
 * the responsible party per missing doc").
 *
 * THE CONDITION (the SAME canonical gap the G1 TaskWatcher detects): a project in
 * `gathering_signatures` that is MISSING a required document type for its renewal
 * track. Where TaskWatcher proposes an INTERNAL `task.create` (open a system task
 * for the org to chase the paperwork itself), THIS recommender proposes an
 * OUTBOUND `document.chase.send` — the system, on the manager's one-click confirm,
 * CHASES the responsible PARTY (the שמאי for a שומה, the אדריכל for a blueprint, the
 * עו״ד for a תקנון, …) to deliver the missing document.
 *
 * ── ONE SOURCE OF TRUTH — reuse, never re-implement (owner 2026-06-23) ───────
 * Detection is NOT re-coded here. It reuses the SHARED canonical
 * `detectMissingRequiredDocs` — the SAME set-based query (same required-set, same
 * DH1+legacy scope resolution) that TaskWatcher uses and that the DocumentsService
 * `boardCompleteness.projectsBehind` / DH2 checklist derive from. No second
 * requirements computation — a re-skin of the board's numbers and this chase can
 * never drift.
 *
 * The chase TARGET (which party) is the missing doc TYPE mapped through the
 * canonical `providerPartyForDocType` (the ONE party-mapping the board, the search
 * `party` filter, and the binder share). That mapping lives in `@emapp/shared-types`
 * and `@emapp/db` deliberately does NOT depend on shared-types (the package cycle
 * rule — db mirrors shared-types structurally, never imports it). So the recommender
 * carries the missing TYPE in its evidence (the source of truth) and the party is
 * DERIVED downstream — in the executor + the FE — via the one canonical function.
 * No second party map is introduced; the type→party derivation stays single-sourced.
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'document.chase.send:<projectId>:<docType>'` — DETERMINISTIC per
 * (project, missing required type); no timestamp/nonce. The partial-unique on
 * `proposals(org_id, dedup_key) WHERE pending` makes a re-detection of the same gap
 * a no-op while the proposal is live; once approved/rejected the key releases, so a
 * gap that re-opens later (the doc is archived again) can re-propose. The key is
 * DISTINCT from the TaskWatcher key (different kind prefix), so the same gap can
 * carry BOTH a "open a task" and a "chase the party" proposal without colliding —
 * they are two different proposed actions on the one condition.
 *
 * ── Classification (AutonomyPolicy) ─────────────────────────────────────────
 * `document.chase.send` classifies as `proposeConfirm` — OUTBOUND ⇒ NEVER
 * auto-execute (THE ONE BOUNDARY: autoExecute requires non-outbound). The producer
 * DRAFTS it; the manager confirms one-click; the executor routes the actual send
 * through `governOutboundSend` with the REAL recipient consent state (fail-closed
 * until the opt-out registry + party-recipient resolver land — never a hardcoded
 * `recipientConsented:true`, the #516 consent-bypass).
 *
 * NO PII: the evidence snapshot carries the project id + the missing doc-type key +
 * the derived party key + the track only — never owner national_id/phone/name, and
 * never the chased party's contact details (those are resolved at SEND time inside
 * the gated method, never in the proposal). Document TYPE/party keys are taxonomy.
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';

import { detectMissingRequiredDocs } from './missing-required-doc.detect';

/** The kind the produced proposals carry (classified outbound + consent →
 *  proposeConfirm; NEVER auto-execute). */
export const DOCUMENT_CHASE_KIND = 'document.chase.send' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const DOCUMENT_CHASE_RECOMMENDER_ID = 'document-chase' as const;

/** Default proposal TTL: a chase proposal the manager never touches retires after
 *  14 days so the inbox stays calm. The gap (if still open) re-surfaces on a later
 *  tick once the key releases. Mirrors the TaskWatcher TTL. */
export const DOCUMENT_CHASE_PROPOSAL_TTL_DAYS = 14;

export interface DocumentChaseRecommenderOptions {
  proposalTtlDays?: number;
}

/**
 * Build the DocumentChase recommender. Pure detection — it reads the canonical
 * missing-required-doc gaps and maps each to one OUTBOUND chase condition,
 * deriving the responsible party from the missing type. The generic
 * ProposalProducer does the per-tenant emit; the executor does the governed send.
 */
export function createDocumentChaseRecommender(
  opts: DocumentChaseRecommenderOptions = {},
): IRecommender {
  const proposalTtlDays = opts.proposalTtlDays ?? DOCUMENT_CHASE_PROPOSAL_TTL_DAYS;

  return {
    id: DOCUMENT_CHASE_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const expiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);

      // ONE canonical set-based detection across all orgs — SHARED with the G1
      // TaskWatcher (the SINGLE source of truth for "project missing a required doc
      // type"). No second query, no second required-set.
      const gaps = await detectMissingRequiredDocs();

      return gaps.map((gap): DetectedCondition => ({
        orgId: gap.orgId,
        kind: DOCUMENT_CHASE_KIND,
        scopeType: 'project',
        scopeId: gap.projectId,
        // PII-FREE evidence snapshot: project + missing doc-type + track only. The
        // responsible PARTY is DERIVED downstream (executor + FE) from
        // `missingDocType` via the canonical `providerPartyForDocType` — db does not
        // import shared-types (cycle rule), so the type is the single-sourced fact
        // and the party is computed where shared-types is available, never copied
        // here. The condition discriminator + type let the FE compose the
        // user-framed, PII-free copy ("מומלץ לבקש {type} מ{party}"). NO owner PII, NO
        // party contact details.
        evidence: {
          condition: 'missing_required_doc',
          projectId: gap.projectId,
          projectType: gap.projectType,
          track: gap.track,
          missingDocType: gap.missingDocType,
        },
        // DETERMINISTIC dedup key per (project, missing type) — no timestamp/nonce.
        // Distinct prefix from the TaskWatcher key so both proposals can coexist for
        // the one gap (open-a-task vs chase-the-party).
        dedupKey: `${DOCUMENT_CHASE_KIND}:${gap.projectId}:${gap.missingDocType}`,
        expiresAt,
      }));
    },
  };
}
