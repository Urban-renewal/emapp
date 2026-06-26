/**
 * `docSatisfiesRequirementPredicate` — the ONE canonical SQL predicate for
 * "does THIS document still satisfy the required-doc requirement it is filed
 * against?" (the legal-validity half of required-doc completeness).
 *
 * ── Why this exists (single-source-of-truth, the charter's #1 forbidden defect) ─
 * TWO surfaces compute the SAME fact — "does this project HAVE its required
 * docs?" — from the SAME underlying per-doc condition:
 *   • `detectMissingRequiredDocs` (the recommender path)      — raw SQL CTE.
 *   • `DocumentsService.boardCompleteness` (the cockpit board) — Drizzle query.
 * Before this seam, the 2.6 future-states sharpening (a doc that is legally
 * rejected / superseded / expired no longer counts) lived ONLY in the recommender
 * CTE. The board's "received" query decided satisfaction on type + scope +
 * archived_at ALONE, so the instant a manager marked a required doc rejected /
 * superseded / expired the two surfaces DRIFTED — the recommender said "missing"
 * while the board still showed "received/complete". That is exactly the
 * two-unaligned-queries-for-one-fact defect (the "0 מתוך X" board bug).
 *
 * So the triple lives HERE, once, and BOTH call sites consume this function.
 * After the fix there is NO second place that independently decides whether a
 * doc satisfies its requirement — they CANNOT drift again.
 *
 * ── The predicate (ADDITIVE — NULL is "not-invalidating") ───────────────────
 *   (legal_status  IS DISTINCT FROM 'rejected')      -- not legally rejected
 *   AND (version_state IS DISTINCT FROM 'superseded') -- the current version
 *   AND (valid_until IS NULL OR valid_until >= now()) -- not expired
 *
 * Every clause is phrased so a NULL value (every pre-2.6 row, and any doc that
 * never sets a 2.6 state) is "not invalidating":
 *   • legal_status NULL  → IS DISTINCT FROM 'rejected'   is TRUE
 *   • version_state NULL → IS DISTINCT FROM 'superseded' is TRUE
 *   • valid_until NULL   → the OR short-circuits TRUE
 * So with every 2.6 column NULL (the state of all existing data) the predicate
 * is BYTE-IDENTICAL to "always TRUE" — the only docs newly EXCLUDED are ones a
 * manager has EXPLICITLY marked rejected / superseded / expired. Both call sites
 * inherit the sharpening — and any future tightening — automatically.
 *
 * ── Dialect-agnostic by design ──────────────────────────────────────────────
 * The caller passes the three column references AS `SQL` expressions in ITS OWN
 * dialect: the recommender CTE passes raw aliased columns (`sql.raw('d.legal_status')`
 * etc.); `boardCompleteness` passes the Drizzle column objects (`documents.legalStatus`
 * etc.). Drizzle renders both to the same final SQL, so the ONE predicate body is
 * shared while each site keeps its own column binding. NO PII: legal/version/
 * validity state are taxonomy, never an owner national_id/phone/name.
 */
import { sql, type SQL } from 'drizzle-orm';

/**
 * Build the canonical "this doc satisfies its required-doc requirement" SQL
 * predicate from a site's three 2.6-state column expressions.
 *
 * @param legalStatus   the `legal_status`   column expression (raw or Drizzle col)
 * @param versionState  the `version_state`  column expression
 * @param validUntil    the `valid_until`    column expression
 */
export function docSatisfiesRequirementPredicate(
  legalStatus: SQL,
  versionState: SQL,
  validUntil: SQL,
): SQL {
  return sql`${legalStatus} IS DISTINCT FROM 'rejected' AND ${versionState} IS DISTINCT FROM 'superseded' AND (${validUntil} IS NULL OR ${validUntil} >= now())`;
}
