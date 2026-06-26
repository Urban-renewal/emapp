/**
 * `detectProjectSignatureActivity` — the ONE canonical, set-based detection of a
 * NON-TERMINAL project's PENDING-signature activity (pending count + oldest-pending
 * age + next-expiry), shared by the perception-driven signature recommenders
 * (Autonomous Managing System, wave 1.3).
 *
 * ── Why this is factored out (one-source-of-truth, owner 2026-06-23) ─────────
 * TWO recommenders act on a project's pending-signature situation:
 *   - `SignatureStalledRecommender`  → a project whose collection has STALLED
 *     (pending > 0 ∧ oldest-pending age ≥ threshold) → propose `reminder.send`.
 *   - `SignatureExpiringRecommender` → a project whose NEXT pending request is
 *     LAPSING SOON (next-expiry within the window) → propose
 *     `signature_request.reissue`.
 * They differ ONLY in WHICH fact they threshold + the proposal KIND. The
 * underlying facts — pending count, oldest-pending timestamp, next-expiry — are
 * IDENTICAL. Computing them twice in two slightly-different queries is exactly the
 * divergent-parallel-implementation defect the charter forbids, so the detection
 * lives HERE, once, and both recommenders consume these rows.
 *
 * ── These ARE the ProjectPerception signature/activity fields ────────────────
 * `pending`, `oldestPendingAt`/`oldestPendingAgeDays`, and `nextExpiryAt` are the
 * EXACT `ProjectPerception.signatures.pending` / `activity.oldestPendingAgeDays` /
 * `activity.nextExpiryAt` the wave-1.1 assembler (`assembleProjectPerception`)
 * exposes — derived the SAME way: the canonical `projectSignatureDocIdsSql`
 * doc-scope (project-level docs ∪ apartment→building docs, non-archived), `pending`
 * status, `MIN(created_at)` for the oldest-pending, `MIN(expires_at)` for the next
 * expiry, and the same `floor((now - oldestPendingAt)/day)` age derive. This
 * recommender therefore READS the perception's signature/activity facts WITHOUT
 * re-deriving them differently — it is the SCALABLE, fleet-wide projection of that
 * read-model (the full assembler also computes consent/holdouts/missing-docs, which
 * these recommenders do not need; running all of it across every org every tick
 * is needless work, so this focuses on the signature facts via the SAME seam).
 *
 * ── Set-based + scalable, on the CANONICAL seam (design correction H-runtime) ─
 * ONE query across ALL orgs via the BYPASSRLS pool (`providerDb`) — like every
 * other recommender detection (`detectMissingRequiredDocs`, reminder-cadence). It
 * is PROJECT-FIRST: it starts from the bounded set of non-terminal, non-archived
 * projects, then resolves each project's signature-bearing documents through the
 * CANONICAL doc-scope seam `projectSetSignatureDocIdsSql` (in `signature-progress.ts`)
 * — the SAME UNION (project-level docs ∪ apartment→building docs, non-archived) the
 * wave-1.1 assembler's `sigs` CTE consumes via `projectSignatureDocIdsSql`. There is
 * NO hand-rolled `COALESCE(d.project_id, b.project_id)` doc→project resolution here:
 * that was a divergent parallel implementation of the seam, and it DROPPED a document
 * linked to BOTH a project P (`project_id`) AND an apartment whose building is in a
 * project Q≠P from Q's count (the COALESCE picked P only), whereas the canonical UNION
 * attributes it to BOTH. Reusing the seam makes this projection IDENTICAL to the
 * assembler's per-project attribution — ONE source of truth, so a future seam change
 * (a 3rd doc-path, a D.57 rule change) flows here for free and cannot drift.
 *
 * SCALABILITY is preserved: a single set-based aggregate joins the project set to its
 * canonical doc scope (`projectSetSignatureDocIdsSql` over the WHOLE live-project set
 * at once — no per-project N+1, no statement_timeout) and to the bounded pending
 * signature_requests, then aggregates per project. The doc-scope resolution rides the
 * seam's partial-index path, so this stays fast at fleet scale.
 *
 * NO PII: every returned column is a project id / org id / count / timestamp —
 * never an owner national_id/phone/name.
 */
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';
import { projectSetSignatureDocIdsSql } from '../signature-progress';

/** One project's pending-signature activity. PII-FREE: ids + counts + timestamps. */
export interface ProjectSignatureActivityRow {
  /** The org the project belongs to (the producer writes per-tenant). */
  orgId: string;
  /** The non-terminal project with pending signatures. */
  projectId: string;
  /** How many pending signature requests the project has (on the canonical scope). */
  pending: number;
  /** The oldest pending request's created_at (ISO UTC) — the stall clock origin. */
  oldestPendingAt: string | null;
  /** Age in whole days of the oldest pending request (floor((now-oldest)/day)). */
  oldestPendingAgeDays: number | null;
  /** The nearest pending request's expires_at (ISO UTC) — the lapse clock. */
  nextExpiryAt: string | null;
}

/** Bound the working set per tick (mirrors the other recommender detect limits). */
export const SIGNATURE_ACTIVITY_DETECT_LIMIT = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Detect every non-terminal project's pending-signature activity across ALL orgs,
 * once. PENDING-FIRST + set-based (scalable at fleet scale). `now` is injected so
 * the age derive is deterministic in tests.
 */
export async function detectProjectSignatureActivity(
  now: Date,
): Promise<ProjectSignatureActivityRow[]> {
  const result = await providerDb.execute(sql`
    -- PROJECT-FIRST: start from the bounded set of non-terminal, non-archived
    -- projects, then resolve each project's signature-bearing documents through the
    -- CANONICAL doc-scope seam (projectSetSignatureDocIdsSql) — the SAME UNION the
    -- assembler uses. A doc linked to BOTH a project (project_id) AND an apartment
    -- whose building is in ANOTHER project is attributed to BOTH, exactly as the
    -- seam defines it — no hand-rolled COALESCE, single source of truth.
    WITH live_projects AS (
      SELECT p.id, p.org_id
      FROM projects p
      WHERE p.archived_at IS NULL
        AND p.status NOT IN ('completed', 'cancelled')
    ),
    -- (project_id, document_id) pairs via the canonical seam, scoped per project
    -- through a LATERAL correlated single-project subquery. Because the seam is a
    -- UNION over the two doc-paths, a dual-linked doc surfaces under every project
    -- whose scope claims it — the attribution the assembler's sigs CTE produces.
    project_docs AS (
      SELECT lp.id AS project_id, lp.org_id, scope.id AS document_id
      FROM live_projects lp
      JOIN LATERAL (
        ${projectSetSignatureDocIdsSql(sql`SELECT lp.id`)}
      ) AS scope(id) ON TRUE
    )
    SELECT
      pd.project_id,
      pd.org_id,
      COUNT(*)::int        AS pending,
      MIN(sr.created_at)   AS oldest_pending_at,
      MIN(sr.expires_at)   AS next_expiry_at
    FROM project_docs pd
    JOIN signature_requests sr
      ON sr.document_id = pd.document_id
     AND sr.status = 'pending'
    GROUP BY pd.project_id, pd.org_id
    ORDER BY pd.org_id, pd.project_id
    LIMIT ${SIGNATURE_ACTIVITY_DETECT_LIMIT}
  `);

  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
  const nowMs = now.getTime();

  return rows.map((row): ProjectSignatureActivityRow => {
    const oldestPendingAt = toIso(row['oldest_pending_at']);
    // SAME derive as the perception assembler's mapPerceptionRow.
    const oldestPendingAgeDays =
      oldestPendingAt === null
        ? null
        : Math.max(0, Math.floor((nowMs - Date.parse(oldestPendingAt)) / DAY_MS));

    return {
      orgId: String(row['org_id']),
      projectId: String(row['project_id']),
      pending: Number(row['pending'] ?? 0),
      oldestPendingAt,
      oldestPendingAgeDays,
      nextExpiryAt: toIso(row['next_expiry_at']),
    };
  });
}

/** pg timestamp → ISO UTC string | null (Date or string both arrive from pg). */
function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
