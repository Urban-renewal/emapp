/**
 * `TaskWatcher` — the G1 autonomy recommender (Autonomous Master Plan, gap-closure
 * G1: "Tasks — the system's OWN work-tracking surface"; "the biggest gap closed").
 *
 * THE CONDITION (the cleanest, highest-signal first cut): a project in
 * `gathering_signatures` that is MISSING a required document type for its renewal
 * track. The required-doc set per track is the SAME advisory law the project
 * document-checklist uses (`REQUIRED_DOC_TYPES_BY_TRACK`): every track needs an
 * agreement + land_registry (נסח טאבו) + blueprint; פינוי-בינוי additionally needs
 * a regulation (תקנון). A gathering-signatures project lacking any of these is real,
 * actionable work — the manager should open a task to chase the missing paperwork —
 * and today nothing surfaces it. Each missing (project, doc-type) pair becomes ONE
 * `task.create` proposal: "חסר נסח טאבו בפרויקט — מוצע לפתוח משימה".
 *
 * Why this condition (vs. "overdue signature request with no follow-up"): the
 * missing-required-doc check is a clean, self-contained set-based JOIN over data
 * that already exists (projects + documents + the proven required-set), it carries
 * ZERO PII (doc-type keys + project ids only), and the resolution signal is crisp
 * (the doc arrives → the condition clears), making it the textbook first TaskWatcher
 * condition. The overdue-no-follow-up condition overlaps the already-shipped
 * reminder-cadence producer and would double-surface the same chase, so it is
 * deliberately left out of this first cut.
 *
 * ── Set-based detection (design correction H-runtime) ───────────────────────
 * ONE query across ALL orgs via the BYPASSRLS maintenance pool (`providerDb`) —
 * NOT a per-org/per-project loop. The required-doc set is expanded INLINE in SQL
 * (a small VALUES list keyed off the project's track, derived from `projects.type`)
 * and LEFT-JOINed to the project's present, non-archived documents; a NULL match is
 * a missing type. The producer then writes per-tenant (the only necessarily-scoped
 * step). The query reads ONLY non-PII columns (project id/type, doc type) — never an
 * owner_id-joined column.
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'task.create:missing-doc:<projectId>:<docType>'` — DETERMINISTIC per
 * (project, missing type); no timestamp/nonce. The partial-unique on
 * `proposals(org_id, dedup_key) WHERE pending` makes a re-detection of the same gap
 * a no-op while the proposal is live; once approved/rejected the key releases, so a
 * gap that re-opens later (the doc is archived again) can re-propose. The created
 * SYSTEM task carries the SAME key as its `origin_ref`, so the tasks partial-unique
 * (`tasks_system_origin_open_unique`) independently prevents a second open task for
 * the same gap even across proposal lifecycles.
 *
 * NO PII: the evidence snapshot carries the project id + the missing doc type key +
 * the track + counts only — never owner national_id/phone/name (the PII-free-proposal
 * contract). Document TYPE keys ('land_registry', …) are taxonomy, not PII.
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';

import { detectMissingRequiredDocs } from './missing-required-doc.detect';

/** The kind the produced proposals carry (classified internal+reversible+non-PII). */
export const TASK_CREATE_KIND = 'task.create' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const TASK_WATCHER_RECOMMENDER_ID = 'task-watcher' as const;

/** Default proposal TTL: a missing-doc proposal the manager never touches retires
 *  after 14 days so the inbox stays calm. The gap (if still open) re-surfaces on a
 *  later tick once the key releases. */
export const TASK_WATCHER_PROPOSAL_TTL_DAYS = 14;

export interface TaskWatcherRecommenderOptions {
  proposalTtlDays?: number;
}

/**
 * Build the TaskWatcher recommender. Pure detection — it reads gathering-signatures
 * projects + their present doc types and returns one condition per missing required
 * type; the generic ProposalProducer does the per-tenant emit.
 */
export function createTaskWatcherRecommender(
  opts: TaskWatcherRecommenderOptions = {},
): IRecommender {
  const proposalTtlDays = opts.proposalTtlDays ?? TASK_WATCHER_PROPOSAL_TTL_DAYS;

  return {
    id: TASK_WATCHER_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const expiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);

      // ONE canonical set-based detection across all orgs — SHARED with the S5
      // DocumentChaseRecommender (the SINGLE source of truth for "project missing a
      // required doc type", `detectMissingRequiredDocs`). This recommender maps each
      // gap to an INTERNAL `task.create` (open a system task); the chase recommender
      // maps the SAME gaps to an OUTBOUND `document.chase.send`. No second detection
      // query — the scope resolution + required-set live in ONE place.
      const gaps = await detectMissingRequiredDocs();

      return gaps.map((gap): DetectedCondition => ({
        orgId: gap.orgId,
        kind: TASK_CREATE_KIND,
        scopeType: 'project',
        scopeId: gap.projectId,
        // PII-FREE evidence snapshot: project + doc-type taxonomy + track only.
        // The condition discriminator lets the executor compose a user-framed,
        // PII-free task title/body without any further lookup.
        evidence: {
          condition: 'missing_required_doc',
          projectId: gap.projectId,
          projectType: gap.projectType,
          track: gap.track,
          missingDocType: gap.missingDocType,
        },
        // DETERMINISTIC dedup key per (project, missing type) — no timestamp/nonce.
        // Reused verbatim as the created system task's origin_ref.
        dedupKey: `${TASK_CREATE_KIND}:missing-doc:${gap.projectId}:${gap.missingDocType}`,
        expiresAt,
      }));
    },
  };
}
