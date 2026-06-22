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
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

/** The kind the produced proposals carry (classified internal+reversible+non-PII). */
export const TASK_CREATE_KIND = 'task.create' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const TASK_WATCHER_RECOMMENDER_ID = 'task-watcher' as const;

/** Default proposal TTL: a missing-doc proposal the manager never touches retires
 *  after 14 days so the inbox stays calm. The gap (if still open) re-surfaces on a
 *  later tick once the key releases. */
export const TASK_WATCHER_PROPOSAL_TTL_DAYS = 14;

/** Bound the working set per tick (mirrors the reissue/cadence recommenders). */
const DETECT_LIMIT = 5000;

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

      // ONE set-based query across all orgs. The required-doc set per track is the
      // canonical advisory law (REQUIRED_DOC_TYPES_BY_TRACK), expanded INLINE here
      // as a VALUES table keyed by track so detection stays a single statement:
      //   tama38 (tama38_1 | tama38_2)        → agreement, land_registry, blueprint
      //   pinui_binui                         → + regulation
      //   default (other / unknown)           → agreement, land_registry, blueprint
      //
      // For each gathering-signatures, non-archived project we cross-join its track's
      // required types and LEFT JOIN to a present (non-archived) document of that type
      // scoped to the project (DH1 canonical doc_scope='project' OR the legacy
      // project_id fallback — same scope resolution as the checklist service). A NULL
      // join = a MISSING required type → one row → one condition.
      const result = await providerDb.execute(sql`
        WITH required AS (
          SELECT * FROM (VALUES
            ('tama38',      'agreement'),
            ('tama38',      'land_registry'),
            ('tama38',      'blueprint'),
            ('pinui_binui', 'agreement'),
            ('pinui_binui', 'land_registry'),
            ('pinui_binui', 'blueprint'),
            ('pinui_binui', 'regulation'),
            ('default',     'agreement'),
            ('default',     'land_registry'),
            ('default',     'blueprint')
          ) AS r(track, doc_type)
        ),
        proj AS (
          SELECT
            p.id   AS project_id,
            p.org_id,
            p.type AS project_type,
            CASE
              WHEN p.type IN ('tama38_1', 'tama38_2') THEN 'tama38'
              WHEN p.type = 'pinui_binui'             THEN 'pinui_binui'
              ELSE 'default'
            END AS track
          FROM projects p
          WHERE p.status = 'gathering_signatures'
            AND p.archived_at IS NULL
        )
        SELECT
          proj.project_id,
          proj.org_id,
          proj.project_type,
          proj.track,
          required.doc_type
        FROM proj
        JOIN required ON required.track = proj.track
        LEFT JOIN documents d
          ON d.type = required.doc_type
         AND d.archived_at IS NULL
         AND (
              (d.doc_scope = 'project' AND d.doc_scope_id = proj.project_id)
           OR d.project_id = proj.project_id
         )
        WHERE d.id IS NULL
        ORDER BY proj.org_id, proj.project_id, required.doc_type
        LIMIT ${DETECT_LIMIT}
      `);

      const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

      return rows.map((row): DetectedCondition => {
        const projectId = String(row['project_id']);
        const orgId = String(row['org_id']);
        const docType = String(row['doc_type']);
        const track = String(row['track']);
        const projectType = String(row['project_type']);
        return {
          orgId,
          kind: TASK_CREATE_KIND,
          scopeType: 'project',
          scopeId: projectId,
          // PII-FREE evidence snapshot: project + doc-type taxonomy + track only.
          // The condition discriminator lets the executor compose a user-framed,
          // PII-free task title/body without any further lookup.
          evidence: {
            condition: 'missing_required_doc',
            projectId,
            projectType,
            track,
            missingDocType: docType,
          },
          // DETERMINISTIC dedup key per (project, missing type) — no timestamp/nonce.
          // Reused verbatim as the created system task's origin_ref.
          dedupKey: `${TASK_CREATE_KIND}:missing-doc:${projectId}:${docType}`,
          expiresAt,
        };
      });
    },
  };
}
