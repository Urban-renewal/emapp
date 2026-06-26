/**
 * `DocExpiryWarnRecommender` — the 2.6 future-states recommender. A required /
 * load-bearing document that is APPROVED and CURRENT but whose legal validity
 * (`valid_until`) lapses SOON, on a non-terminal (gathering-signatures) project,
 * is real, actionable work: the manager should chase a fresh version before the
 * doc expires and silently re-opens a requirement gap. Today nothing surfaces an
 * APPROACHING expiry — only the after-the-fact gap (via the sharpened
 * `detectMissingRequiredDocs`, which drops an already-expired doc). This
 * recommender is the ANTICIPATORY half: warn in the window BEFORE the lapse.
 *
 * THE CONDITION: a non-archived document on a `gathering_signatures`,
 * non-archived project that is
 *   • legal_status = 'approved'         (a load-bearing, accepted doc)
 *   • version_state IS DISTINCT FROM 'superseded'  (the current version)
 *   • valid_until IS NOT NULL AND within [now, now + WINDOW]  (expiring soon)
 * Each such (project, document) becomes ONE `task.create` proposal — the SAME
 * internal kind the G1 TaskWatcher emits (NO new kind, `autonomy-policy.ts`
 * untouched). On the manager's one-click approve the executor opens a SYSTEM
 * task via the existing gated `tasks.create`.
 *
 * ── REUSE, never re-implement ───────────────────────────────────────────────
 * Emits the EXISTING `task.create` kind (classified internal+reversible+non-PII
 * → the executor's discriminated union just gains a `doc_expiry` arm). The
 * project-scope resolution (gathering_signatures ∧ non-archived) mirrors
 * `detectMissingRequiredDocs`. No second engine part, no new policy row.
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'task.create:doc-expiry:<documentId>'` — DETERMINISTIC per
 * document (an expiring doc maps to one warning, regardless of how the window
 * slides). The partial-unique on `proposals(org_id, dedup_key) WHERE pending`
 * makes a re-detection a no-op while live; once approved/rejected the key
 * releases so a re-extended-then-re-expiring doc can re-propose. The key is
 * reused as the created system task's `origin_ref` so the tasks partial-unique
 * independently prevents a duplicate open task. The `doc-expiry` prefix is
 * DISTINCT from the missing-doc prefix, so the two never collide.
 *
 * NO PII: the evidence snapshot carries the project id + document id (opaque
 * uuids) + the doc-type key (taxonomy) + the validUntil timestamp ONLY — never
 * owner national_id/phone/name. Document TYPE keys are taxonomy, not PII.
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

/** The kind the produced proposals carry — the EXISTING internal+reversible
 *  task.create (NO new policy kind; autonomy-policy.ts untouched). Local const
 *  (the canonical export is `TASK_CREATE_KIND` from task-watcher.recommender);
 *  NOT re-exported here to avoid a duplicate barrel export. */
const TASK_CREATE_KIND = 'task.create' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const DOC_EXPIRY_WARN_RECOMMENDER_ID = 'doc-expiry-warn' as const;

/** The look-ahead window: warn when an approved doc lapses within 30 days. */
export const DOC_EXPIRY_WARN_WINDOW_DAYS = 30;

/** Default proposal TTL (mirrors the TaskWatcher / DocumentChase TTLs). */
export const DOC_EXPIRY_WARN_PROPOSAL_TTL_DAYS = 14;

/** Bound the working set per tick (mirrors the missing-doc detect limit). */
export const DOC_EXPIRY_DETECT_LIMIT = 5000;

/** One detected expiring-doc condition. PII-FREE: ids + taxonomy + timestamp. */
export interface ExpiringDocRow {
  orgId: string;
  projectId: string;
  documentId: string;
  docType: string;
  validUntil: Date;
}

/**
 * Detect every approved-current document on a gathering-signatures project that
 * expires within `windowDays`, across ALL orgs, once (set-based — the SAME shape
 * as `detectMissingRequiredDocs`, via the BYPASSRLS maintenance pool). The
 * producer does the per-tenant emit.
 */
export async function detectExpiringApprovedDocs(
  now: Date,
  windowDays: number = DOC_EXPIRY_WARN_WINDOW_DAYS,
): Promise<ExpiringDocRow[]> {
  const horizon = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
  const result = await providerDb.execute(sql`
    SELECT
      d.org_id,
      p.id          AS project_id,
      d.id          AS document_id,
      d.type        AS doc_type,
      d.valid_until AS valid_until
    FROM documents d
    JOIN projects p
      ON p.status = 'gathering_signatures'
     AND p.archived_at IS NULL
     AND (
          (d.doc_scope = 'project' AND d.doc_scope_id = p.id)
       OR d.project_id = p.id
     )
    WHERE d.archived_at IS NULL
      AND d.legal_status = 'approved'
      AND d.version_state IS DISTINCT FROM 'superseded'
      AND d.valid_until IS NOT NULL
      AND d.valid_until >= ${now}
      AND d.valid_until <= ${horizon}
    ORDER BY d.org_id, p.id, d.valid_until
    LIMIT ${DOC_EXPIRY_DETECT_LIMIT}
  `);

  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
  return rows.map(
    (row): ExpiringDocRow => ({
      orgId: String(row['org_id']),
      projectId: String(row['project_id']),
      documentId: String(row['document_id']),
      docType: String(row['doc_type']),
      validUntil: new Date(String(row['valid_until'])),
    }),
  );
}

export interface DocExpiryWarnRecommenderOptions {
  proposalTtlDays?: number;
  windowDays?: number;
}

/**
 * Build the DocExpiryWarn recommender. Pure detection — it reads expiring
 * approved docs and maps each to one INTERNAL `task.create` condition; the
 * generic ProposalProducer does the per-tenant emit, and the executor's
 * `doc_expiry` arm opens the system task on approve.
 */
export function createDocExpiryWarnRecommender(
  opts: DocExpiryWarnRecommenderOptions = {},
): IRecommender {
  const proposalTtlDays = opts.proposalTtlDays ?? DOC_EXPIRY_WARN_PROPOSAL_TTL_DAYS;
  const windowDays = opts.windowDays ?? DOC_EXPIRY_WARN_WINDOW_DAYS;

  return {
    id: DOC_EXPIRY_WARN_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const expiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);
      const docs = await detectExpiringApprovedDocs(ctx.now, windowDays);

      return docs.map(
        (d): DetectedCondition => ({
          orgId: d.orgId,
          kind: TASK_CREATE_KIND,
          scopeType: 'project',
          scopeId: d.projectId,
          // PII-FREE evidence: project + document ids + doc-type taxonomy + the
          // expiry timestamp only. The `condition` discriminator routes the
          // executor's task.create union to the doc_expiry arm.
          evidence: {
            condition: 'doc_expiry',
            projectId: d.projectId,
            documentId: d.documentId,
            docType: d.docType,
            validUntil: d.validUntil.toISOString(),
          },
          // DETERMINISTIC per document; distinct prefix from the missing-doc key.
          dedupKey: `${TASK_CREATE_KIND}:doc-expiry:${d.documentId}`,
          expiresAt,
        }),
      );
    },
  };
}
