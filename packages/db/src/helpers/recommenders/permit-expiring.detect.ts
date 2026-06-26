/**
 * `detectExpiringPermits` — the ONE canonical, set-based detection of "a live
 * project's building permit (היתר בנייה) is approaching expiry or has already
 * lapsed" (wave-2.4 future-states). The SINGLE source of truth for the
 * `permit-expiring` recommender.
 *
 * ── Set-based detection ──────────────────────────────────────────────────────
 * ONE query across ALL orgs via the BYPASSRLS maintenance pool (`providerDb`) —
 * NOT a per-org/per-project loop. The producer then writes per-tenant (the only
 * necessarily-scoped step). Index-backed by `idx_projects_permit_expiry`
 * (migration 0083): partial on approved permits with an expiry, non-archived.
 *
 * ── The condition ───────────────────────────────────────────────────────────
 * A project qualifies when ALL hold:
 *   - `permit_status = 'approved'` — only a granted permit can lapse (an
 *     'applied'/'rejected'/'none'/'expired' project is not "expiring").
 *   - `permit_expiry_at IS NOT NULL` AND `permit_expiry_at <= now + window`
 *     — within the warning window OR already passed (passed = `<= now`, a strict
 *     subset of `<= now + window`, so the single bound covers both; the
 *     `alreadyExpired` flag distinguishes them for the proposal copy).
 *   - `status NOT IN ('completed','cancelled')` — terminal deals need no chase
 *     (mirrors `PROJECT_TERMINAL_STATUSES`, pinned in SQL; kept in lock-step by
 *     the recommender spec). `in_construction` IS included: a permit that lapses
 *     mid-construction is exactly the costly case worth surfacing.
 *   - `archived_at IS NULL` — an archived (soft-deleted) project is out of scope.
 *
 * NO PII: every returned column is a project id / org id / status / a date —
 * never an owner national_id/phone/name.
 */
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

/** One detected expiring-permit condition. PII-FREE: ids + status + dates only. */
export interface ExpiringPermitRow {
  /** The org the project belongs to (the producer writes per-tenant). */
  orgId: string;
  /** The live project whose approved permit is expiring (or has expired). */
  projectId: string;
  /** The project's D.18 status (audit/debug aid; non-terminal by construction). */
  projectStatus: string;
  /** The permit's expiry instant (ISO string from the driver). */
  permitExpiryAt: string;
  /** True iff the permit has ALREADY lapsed at `now` (vs. merely approaching). */
  alreadyExpired: boolean;
}

/** Bound the working set per tick (mirrors the other recommenders). */
export const PERMIT_EXPIRING_DETECT_LIMIT = 5000;

/** Default warning window: surface a permit within ~30 days of expiry. */
export const PERMIT_EXPIRING_WINDOW_DAYS = 30;

/**
 * Detect every (project) whose approved permit is within `windowDays` of expiry
 * (or already past it), across ALL orgs, once. `now` is injected so the window
 * is deterministic per tick (mirrors the cadence/reissue recommenders).
 */
export async function detectExpiringPermits(
  now: Date,
  windowDays: number = PERMIT_EXPIRING_WINDOW_DAYS,
): Promise<ExpiringPermitRow[]> {
  const nowIso = now.toISOString();
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await providerDb.execute(sql`
    SELECT
      p.id        AS project_id,
      p.org_id    AS org_id,
      p.status    AS project_status,
      p.permit_expiry_at AS permit_expiry_at,
      (p.permit_expiry_at <= ${nowIso}::timestamptz) AS already_expired
    FROM projects p
    WHERE p.permit_status = 'approved'
      AND p.permit_expiry_at IS NOT NULL
      AND p.permit_expiry_at <= ${windowEnd}::timestamptz
      AND p.status NOT IN ('completed', 'cancelled')
      AND p.archived_at IS NULL
    ORDER BY p.org_id, p.permit_expiry_at, p.id
    LIMIT ${PERMIT_EXPIRING_DETECT_LIMIT}
  `);

  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

  return rows.map(
    (row): ExpiringPermitRow => ({
      orgId: String(row['org_id']),
      projectId: String(row['project_id']),
      projectStatus: String(row['project_status']),
      permitExpiryAt: new Date(row['permit_expiry_at'] as string | Date).toISOString(),
      alreadyExpired: row['already_expired'] === true,
    }),
  );
}
