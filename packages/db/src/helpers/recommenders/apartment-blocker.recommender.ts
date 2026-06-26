/**
 * `ApartmentBlockerRecommender` — Slice 2.7 (Wave 2.7, apartment legal/life states).
 *
 * The structural MIRROR of `ownership-mismatch.recommender.ts` (2.5), adapted to
 * APARTMENTS.
 *
 * THE CONDITION: a project in `gathering_signatures` has a non-archived APARTMENT
 * carrying an ACTIVE BLOCKING apartment-state — an active `eviction` (a tenancy
 * removal is in flight), `dispute` (an open ownership/boundary dispute contests the
 * unit), or `deceased` (a registered owner is deceased; rights pass to an estate
 * before a binding signature). Such a unit cannot legitimately complete the
 * signature process yet, so its apartment may read as "almost there" while a
 * load-bearing legal block is open. That is real, actionable work the manager should
 * see — each (project, blocking apartment) pair becomes ONE `task.create` proposal.
 *
 * ── REUSE, NOT A NEW KIND (the SOLID constraint of the brief) ────────────────
 * This is a NEW `IRecommender` (drop-in), NOT a new engine part and NOT a new
 * autonomy kind: it emits the EXISTING `task.create` kind — so `autonomy-policy.ts`
 * ACTION_TABLE is UNTOUCHED (verify in PR). It registers on the EXISTING proposal
 * producer alongside task-watcher / document-chase / signature-* / ownership-mismatch.
 *
 * ── Set-based detection (the detectMissingRequiredDocs pattern) ──────────────
 * ONE query across ALL orgs via the BYPASSRLS maintenance pool (`providerDb`) — NOT
 * a per-org/per-project loop. It joins gathering-signatures projects → their
 * non-archived apartments → the apartment's ACTIVE, non-archived blocking
 * apartment_states. The producer then writes per-tenant (the only necessarily-scoped
 * step).
 *
 * ── PII-FREE EVIDENCE (the hard rule) ───────────────────────────────────────
 * The evidence snapshot carries the `apartmentId` + the `stateKind` taxonomy + the
 * `projectId` ONLY. apartment_states has NO PII columns at all, so there is nothing
 * to leak — but the contract is stated explicitly: `apartmentId` is an opaque uuid
 * (an id, not PII); `stateKind` is a closed taxonomy value.
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'task.create:apartment-blocker:<projectId>:<apartmentId>'` —
 * DETERMINISTIC per (project, blocking apartment); no timestamp/nonce. The
 * partial-unique on `proposals(org_id, dedup_key) WHERE pending` makes a
 * re-detection of the same block a no-op while the proposal is live; once
 * approved/rejected the key releases, so a block that re-opens later can re-propose.
 * Distinct prefix from the missing-doc + ownership-mismatch task keys so the
 * `task.create` signals never collide.
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

/** The kind the produced proposals carry (classified internal+reversible+non-PII —
 *  the SAME kind task-watcher uses; NO new autonomy kind is introduced). */
export const APARTMENT_BLOCKER_KIND = 'task.create' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const APARTMENT_BLOCKER_RECOMMENDER_ID = 'apartment-blocker-flag' as const;

/** Default proposal TTL: a block the manager never touches retires after 14d
 *  (mirrors the task-watcher / ownership-mismatch TTL — the inbox stays calm). The
 *  block, if still open, re-surfaces on a later tick once the key releases. */
export const APARTMENT_BLOCKER_PROPOSAL_TTL_DAYS = 14;

/** Bound the working set per tick (mirrors the other detect limits). */
export const APARTMENT_BLOCKER_DETECT_LIMIT = 5000;

/** One detected blocking-apartment condition. PII-FREE: ids + taxonomy key only. */
interface ApartmentBlockerRow {
  orgId: string;
  projectId: string;
  apartmentId: string;
  stateKind: string;
}

export interface ApartmentBlockerRecommenderOptions {
  proposalTtlDays?: number;
}

/**
 * Build the apartment-blocker recommender. Pure detection — it reads the blocking
 * apartment-states on gathering-signatures projects and returns one condition per
 * (project, blocking apartment); the generic ProposalProducer does the per-tenant
 * emit.
 */
export function createApartmentBlockerRecommender(
  opts: ApartmentBlockerRecommenderOptions = {},
): IRecommender {
  const proposalTtlDays = opts.proposalTtlDays ?? APARTMENT_BLOCKER_PROPOSAL_TTL_DAYS;

  return {
    id: APARTMENT_BLOCKER_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const expiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);
      const rows = await detectApartmentBlockers();

      return rows.map(
        (row): DetectedCondition => ({
          orgId: row.orgId,
          kind: APARTMENT_BLOCKER_KIND,
          scopeType: 'project',
          scopeId: row.projectId,
          // PII-FREE evidence: project + apartment id (opaque uuid) + blocking state
          // kind taxonomy ONLY (apartment_states has no PII columns at all).
          evidence: {
            condition: 'apartment_blocker',
            projectId: row.projectId,
            apartmentId: row.apartmentId,
            stateKind: row.stateKind,
          },
          // DETERMINISTIC dedup key per (project, blocking apartment) — no timestamp/
          // nonce. Distinct prefix from the missing-doc + ownership-mismatch task keys
          // so the three never collide.
          dedupKey: `${APARTMENT_BLOCKER_KIND}:apartment-blocker:${row.projectId}:${row.apartmentId}`,
          expiresAt,
        }),
      );
    },
  };
}

/**
 * Detect every (gathering-signatures project, blocking apartment) pair across ALL
 * orgs, once. A "blocking apartment" = a non-archived apartment of a gathering-
 * signatures project that carries an ACTIVE, non-archived apartment_state of a
 * BLOCKING kind (`deceased` | `dispute` | `eviction`). PII-FREE: ids + kind only
 * (apartment_states has no PII columns to select).
 */
async function detectApartmentBlockers(): Promise<ApartmentBlockerRow[]> {
  const result = await providerDb.execute(sql`
    SELECT DISTINCT
      p.org_id        AS org_id,
      p.id            AS project_id,
      ast.apartment_id AS apartment_id,
      ast.kind        AS state_kind
    FROM projects p
    INNER JOIN buildings b   ON b.project_id = p.id
    INNER JOIN apartments a  ON a.building_id = b.id AND a.archived_at IS NULL
    INNER JOIN apartment_states ast ON ast.apartment_id = a.id
                                   AND ast.org_id = p.org_id
                                   AND ast.status = 'active'
                                   AND ast.archived_at IS NULL
                                   AND ast.kind IN ('deceased', 'dispute', 'eviction')
    WHERE p.status = 'gathering_signatures'
      AND p.archived_at IS NULL
    ORDER BY p.org_id, p.id, ast.apartment_id
    LIMIT ${APARTMENT_BLOCKER_DETECT_LIMIT}
  `);

  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

  return rows.map(
    (row): ApartmentBlockerRow => ({
      orgId: String(row['org_id']),
      projectId: String(row['project_id']),
      apartmentId: String(row['apartment_id']),
      stateKind: String(row['state_kind']),
    }),
  );
}
