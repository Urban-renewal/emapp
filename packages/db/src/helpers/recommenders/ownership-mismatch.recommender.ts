/**
 * `OwnershipMismatchRecommender` — Slice 2.5 (Wave 2.5, owner legal/life states).
 *
 * THE CONDITION: a project in `gathering_signatures` has an ACTIVE OWNER who is
 * counted in the consent threshold but carries a BLOCKING owner-state — an active
 * `competency` (the owner lacks capacity; a guardian must act) or `dispute` (an
 * ownership dispute contests their consent). Such an owner's signature cannot be
 * relied on, yet the consent math still counts them, so the threshold can read as
 * "almost there" while a load-bearing owner is legally blocked. That is real,
 * actionable work the manager should see — each (project, blocking owner) pair
 * becomes ONE `task.create` proposal ("בעלים בפרויקט מסומן כחסום — מומלץ לפתוח
 * משימה לבירור").
 *
 * ── REUSE, NOT A NEW KIND (the SOLID constraint of the brief) ────────────────
 * This is a NEW `IRecommender` (drop-in), NOT a new engine part and NOT a new
 * autonomy kind: it emits the EXISTING `task.create` kind — so `autonomy-policy.ts`
 * ACTION_TABLE is UNTOUCHED (verify in PR). It registers on the EXISTING proposal
 * producer alongside task-watcher / document-chase / signature-* . The consent
 * notion it keys off is the SAME `relationship='owner' AND ended_at IS NULL` active-
 * owner seam the canonical `assembleProjectPerception` holdouts/consent CTEs use —
 * no divergent consent re-implementation.
 *
 * ── Set-based detection (the detectMissingRequiredDocs pattern) ──────────────
 * ONE query across ALL orgs via the BYPASSRLS maintenance pool (`providerDb`) —
 * NOT a per-org/per-project loop. It joins gathering-signatures projects → their
 * non-archived apartments → active ownerships → the apartment's/owner's ACTIVE,
 * non-archived blocking owner_states. The producer then writes per-tenant (the
 * only necessarily-scoped step).
 *
 * ── PII-FREE EVIDENCE (the hard rule) ───────────────────────────────────────
 * The evidence snapshot carries the `ownerId` + the `stateKind` taxonomy + the
 * `projectId` ONLY — NEVER the owner's name/national_id/phone and NEVER the
 * guardian PII. `ownerId` is an opaque uuid (an id, not PII); `stateKind` is a
 * closed taxonomy value. The blocking owner-state's guardian columns are NEVER
 * selected by this query.
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'task.create:ownership-mismatch:<projectId>:<ownerId>'` — DETERMINISTIC
 * per (project, blocking owner); no timestamp/nonce. The partial-unique on
 * `proposals(org_id, dedup_key) WHERE pending` makes a re-detection of the same
 * block a no-op while the proposal is live; once approved/rejected the key releases,
 * so a block that re-opens later can re-propose. Distinct prefix from the
 * missing-doc task key so the two `task.create` signals never collide.
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

/** The kind the produced proposals carry (classified internal+reversible+non-PII —
 *  the SAME kind task-watcher uses; NO new autonomy kind is introduced). */
export const OWNERSHIP_MISMATCH_KIND = 'task.create' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const OWNERSHIP_MISMATCH_RECOMMENDER_ID = 'ownership-mismatch-flag' as const;

/** Default proposal TTL: a mismatch the manager never touches retires after 14d
 *  (mirrors the task-watcher TTL — the inbox stays calm). The block, if still
 *  open, re-surfaces on a later tick once the key releases. */
export const OWNERSHIP_MISMATCH_PROPOSAL_TTL_DAYS = 14;

/** Bound the working set per tick (mirrors the other detect limits). */
export const OWNERSHIP_MISMATCH_DETECT_LIMIT = 5000;

/** One detected blocking-owner condition. PII-FREE: ids + taxonomy key only. */
interface OwnershipMismatchRow {
  orgId: string;
  projectId: string;
  ownerId: string;
  stateKind: string;
}

export interface OwnershipMismatchRecommenderOptions {
  proposalTtlDays?: number;
}

/**
 * Build the ownership-mismatch recommender. Pure detection — it reads the blocking
 * owner-states on gathering-signatures projects and returns one condition per
 * (project, blocking owner); the generic ProposalProducer does the per-tenant emit.
 */
export function createOwnershipMismatchRecommender(
  opts: OwnershipMismatchRecommenderOptions = {},
): IRecommender {
  const proposalTtlDays = opts.proposalTtlDays ?? OWNERSHIP_MISMATCH_PROPOSAL_TTL_DAYS;

  return {
    id: OWNERSHIP_MISMATCH_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const expiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);
      const rows = await detectOwnershipMismatches();

      return rows.map(
        (row): DetectedCondition => ({
          orgId: row.orgId,
          kind: OWNERSHIP_MISMATCH_KIND,
          scopeType: 'project',
          scopeId: row.projectId,
          // PII-FREE evidence: project + owner id (opaque uuid) + blocking state kind
          // taxonomy ONLY. NO name / national_id / phone / guardian PII.
          evidence: {
            condition: 'ownership_mismatch',
            projectId: row.projectId,
            ownerId: row.ownerId,
            stateKind: row.stateKind,
          },
          // DETERMINISTIC dedup key per (project, blocking owner) — no timestamp/nonce.
          // Distinct prefix from the missing-doc task key so the two never collide.
          dedupKey: `${OWNERSHIP_MISMATCH_KIND}:ownership-mismatch:${row.projectId}:${row.ownerId}`,
          expiresAt,
        }),
      );
    },
  };
}

/**
 * Detect every (gathering-signatures project, blocking active owner) pair across
 * ALL orgs, once. A "blocking owner" = an active, non-archived owner of one of the
 * project's non-archived apartments who carries an ACTIVE, non-archived owner_state
 * of a BLOCKING kind (`competency` | `dispute`). The active-owner seam is the SAME
 * `relationship='owner' AND ended_at IS NULL` the perception consent/holdout CTEs
 * use — no divergent consent re-implementation. PII-FREE: ids + kind only; the
 * guardian_*_encrypted columns are NEVER selected.
 */
async function detectOwnershipMismatches(): Promise<OwnershipMismatchRow[]> {
  const result = await providerDb.execute(sql`
    SELECT DISTINCT
      p.org_id     AS org_id,
      p.id         AS project_id,
      os.owner_id  AS owner_id,
      os.kind      AS state_kind
    FROM projects p
    INNER JOIN buildings b   ON b.project_id = p.id
    INNER JOIN apartments a  ON a.building_id = b.id AND a.archived_at IS NULL
    INNER JOIN ownerships o  ON o.apartment_id = a.id
                            AND o.ended_at IS NULL
                            AND o.relationship = 'owner'
    INNER JOIN owner_states os ON os.owner_id = o.owner_id
                              AND os.org_id = p.org_id
                              AND os.status = 'active'
                              AND os.archived_at IS NULL
                              AND os.kind IN ('competency', 'dispute')
    WHERE p.status = 'gathering_signatures'
      AND p.archived_at IS NULL
    ORDER BY p.org_id, p.id, os.owner_id
    LIMIT ${OWNERSHIP_MISMATCH_DETECT_LIMIT}
  `);

  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

  return rows.map(
    (row): OwnershipMismatchRow => ({
      orgId: String(row['org_id']),
      projectId: String(row['project_id']),
      ownerId: String(row['owner_id']),
      stateKind: String(row['state_kind']),
    }),
  );
}
