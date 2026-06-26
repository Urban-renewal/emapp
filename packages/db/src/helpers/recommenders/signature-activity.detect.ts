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
 * ── Set-based + scalable (design correction H-runtime) ───────────────────────
 * ONE query across ALL orgs via the BYPASSRLS pool (`providerDb`) — like every
 * other recommender detection (`detectMissingRequiredDocs`, reminder-cadence). The
 * query is PENDING-FIRST: it starts from the bounded set of `pending`
 * signature_requests, resolves each to its project via the SAME two doc-paths
 * `projectSignatureDocIdsSql` uses (`documents.project_id` OR the apartment→building
 * chain; non-archived doc), filters to non-terminal/non-archived projects, and
 * aggregates per project. Starting from the pending set (not from every project)
 * keeps the working set small and the query fast at fleet scale.
 *
 * NO PII: every returned column is a project id / org id / count / timestamp —
 * never an owner national_id/phone/name.
 */
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

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
    -- PENDING-FIRST: start from the bounded pending set, resolve project via the
    -- SAME two doc-paths projectSignatureDocIdsSql uses (project_id OR the
    -- apartment→building chain; non-archived doc) — single source of truth for
    -- "which project does this signature belong to".
    WITH sr_project AS (
      SELECT
        sr.org_id,
        sr.created_at,
        sr.expires_at,
        COALESCE(d.project_id, b.project_id) AS project_id
      FROM signature_requests sr
      JOIN documents d ON d.id = sr.document_id AND d.archived_at IS NULL
      LEFT JOIN apartments a ON a.id = d.apartment_id
      LEFT JOIN buildings b ON b.id = a.building_id
      WHERE sr.status = 'pending'
    )
    SELECT
      srp.project_id,
      srp.org_id,
      COUNT(*)::int        AS pending,
      MIN(srp.created_at)  AS oldest_pending_at,
      MIN(srp.expires_at)  AS next_expiry_at
    FROM sr_project srp
    JOIN projects p
      ON p.id = srp.project_id
     AND p.archived_at IS NULL
     AND p.status NOT IN ('completed', 'cancelled')
    WHERE srp.project_id IS NOT NULL
    GROUP BY srp.project_id, srp.org_id
    ORDER BY srp.org_id, srp.project_id
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
