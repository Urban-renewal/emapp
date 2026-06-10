/**
 * Audit-log retention prune — Roadmap P0.C3 (compliance).
 *
 * ── Why this exists (the regulatory clause) ────────────────────────────
 * The Israeli Protection of Privacy Regulations (Data Security), 2017 —
 * high-tier database obligations — require that ACCESS / SECURITY logs be
 * RETAINED for at least 24 months (תקנה 17 / §17, log-keeping clause).
 *
 * Today `audit_log` is the forensic ISO-27001 A.12.4 trail and is NEVER
 * pruned — it satisfies the ≥24-month floor only BY ACCIDENT (it grows
 * without bound), with no ENFORCED, evidenced policy and no growth ceiling.
 * An unbounded table eventually degrades insert/index performance and gives
 * an auditor nothing to point at. This module turns "we keep everything
 * forever by omission" into an EXPLICIT, EVIDENCED retention policy with a
 * compliance floor that cannot be misconfigured away.
 *
 * ── The hard floor (unbypassable in code) ──────────────────────────────
 * The retention window is operator-configurable (AUDIT_RETENTION_MONTHS,
 * default 36) but CLAMPED to a hard floor of 24 months: any configured
 * value below 24 is silently raised to 24 and a warning is logged. This
 * guarantees the regulatory floor holds even on a fat-fingered misconfig
 * (e.g. someone sets 12 to "save space" — the prune still keeps 24 months).
 * There is no env switch, no payload field, no code path that can delete a
 * row younger than 24 months.
 *
 * ── Why a SEPARATE prune, not a REAP_TARGETS entry ─────────────────────
 * The ephemeral reaper (`reap-expired-rows.ts`) deletes rows the app
 * already treats as DEAD the instant they expire (short TTLs, minutes-to-
 * days). audit_log is the OPPOSITE: every row is LIVE forensic evidence for
 * ≥24 months. Folding it into REAP_TARGETS would (a) couple a compliance
 * floor to a housekeeping list and (b) invite a future edit to the short-
 * TTL predicates from silently nuking the audit trail. Retention is its own
 * single-responsibility concern with its own ≥24-month logic, its own
 * cadence, and its own evidence — kept in its own module on purpose.
 *
 * ── Why the BYPASSRLS maintenance pool (`providerDb`) ──────────────────
 * Identical rationale to the ephemeral reaper: this is a SYSTEM cross-org
 * cleanup, not tenant data access. `withTenant` is per-org RLS-scoped (can
 * never see the whole table in one pass); `withProvider` expects a real
 * provider principal + per-row audit. The correct principal is the
 * BYPASSRLS connecting role behind `providerDb` (PROVIDER_DATABASE_URL) —
 * the same bounded, documented exception the reaper, the queue plumbing and
 * the migrations already use.
 *
 * ── Batched delete (no giant transaction on a huge table) ──────────────
 * audit_log can be large. A single unbounded `DELETE ... WHERE created_at <
 * cutoff` would lock and bloat under one long transaction. We delete in
 * BOUNDED CHUNKS (`DELETE ... WHERE id IN (SELECT id ... LIMIT n)`) in a
 * loop until a chunk deletes fewer than the batch size, so each statement is
 * a short, index-assisted transaction.
 *
 * NO PII in logs: only the effective window (months), the cutoff timestamp,
 * and integer deleted-counts are ever emitted. Row contents (which carry
 * national_id / IP / before/after state) are NEVER read or logged.
 *
 * ── Gate-6 carve-out: the age-gated immutability trigger (migration 0060) ──
 * `audit_log` has a `BEFORE UPDATE OR DELETE` trigger (`trg_audit_log_
 * immutable`). It originally RAISED `audit_log rows are immutable` on ANY
 * update OR delete — for EVERY role, including the BYPASSRLS maintenance pool
 * (BYPASSRLS skips RLS POLICIES, not TRIGGERS) — which physically rejected
 * this prune's DELETE. Migration 0060 (Gate-6) replaced ONLY the trigger
 * function body with a TIGHT, age-gated carve-out:
 *   - UPDATE                          → always raises (rows never change).
 *   - DELETE inside the 24-month floor → raises (recent evidence is immutable).
 *   - DELETE older than the 24-month floor → permitted (this prune).
 * The 24-month floor in the trigger is a DB-LEVEL compliance guarantee
 * INDEPENDENT of the app-level clamp in {@link resolveRetentionMonths}
 * (defense in depth: even a misconfigured AUDIT_RETENTION_MONTHS can never
 * make the DB delete a <24mo row). `isAuditLogImmutableError` still recognises
 * the (now narrower) rejection — used by the worker as a belt-and-braces guard
 * for the impossible case where a prune ever presents an inside-floor row.
 * See migration 0060 + docs/COMPLIANCE-audit-log-retention.md.
 */
import { sql } from 'drizzle-orm';

import { providerDb } from '../client';

import type { ReapLogger } from './reap-expired-rows';

/**
 * The regulatory hard floor, in months. The Israeli high-tier Data-Security
 * reg requires access/security logs to be retained ≥24 months. NO configured
 * value may drop the effective window below this — it is clamped in
 * {@link resolveRetentionMonths}. Changing this constant downward is a
 * compliance regression and would fail {@link auditRetentionFloorMonths}'s
 * tests; do not.
 */
export const AUDIT_RETENTION_FLOOR_MONTHS = 24 as const;

/**
 * The default retention window when AUDIT_RETENTION_MONTHS is unset. 36
 * months gives a full year of headroom above the 24-month floor (so a
 * clock/timezone edge never brushes the floor) while still bounding table
 * growth. Operators may RAISE it (e.g. to keep longer) but never lower it
 * below {@link AUDIT_RETENTION_FLOOR_MONTHS}.
 */
export const AUDIT_RETENTION_DEFAULT_MONTHS = 36 as const;

/** Read-only accessor for the floor, for tests / external callers that want
 *  to assert the guarantee without importing the const directly. */
export function auditRetentionFloorMonths(): number {
  return AUDIT_RETENTION_FLOOR_MONTHS;
}

/** The exact message the `audit_log` append-only trigger raises
 *  (`trg_audit_log_immutable`, migration 0003). Exported so the worker
 *  handler and tests can recognise the known blocker without string-pinning
 *  it in two places. */
export const AUDIT_LOG_IMMUTABLE_MESSAGE = 'audit_log rows are immutable' as const;

/**
 * True if `err` (or anything in its `cause` chain) is the append-only
 * immutability-trigger rejection. Drizzle wraps the underlying pg error in a
 * `Failed query: ...` Error and stashes the original (whose message is
 * {@link AUDIT_LOG_IMMUTABLE_MESSAGE}) on `.cause`, so we walk the chain
 * rather than only checking the top-level message.
 */
export function isAuditLogImmutableError(err: unknown): boolean {
  let cur: unknown = err;
  // Bounded walk (cause chains are short; guard against a cycle just in case).
  for (let i = 0; i < 10 && cur != null; i++) {
    if (cur instanceof Error) {
      if (cur.message.includes(AUDIT_LOG_IMMUTABLE_MESSAGE)) return true;
      cur = (cur as { cause?: unknown }).cause;
    } else if (typeof cur === 'object' && 'message' in cur) {
      const m = (cur as { message?: unknown }).message;
      if (typeof m === 'string' && m.includes(AUDIT_LOG_IMMUTABLE_MESSAGE)) return true;
      cur = (cur as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Resolve the EFFECTIVE retention window (in months) from a raw configured
 * value, applying the hard floor. This is the single chokepoint that
 * guarantees compliance:
 *
 *   - unset / empty / non-numeric / ≤0  → default (36).
 *   - any finite value < 24             → clamped UP to 24 (+ warn, if a
 *                                         logger is supplied).
 *   - any value ≥ 24                    → used as-is (operators may keep
 *                                         logs longer than the floor).
 *
 * Pure + side-effect-free except the optional warn log — unit-testable
 * without a DB. The clamp here is the ONLY place the floor is enforced, so
 * every caller (the prune, the job, an ops script) inherits it for free.
 */
export function resolveRetentionMonths(rawValue: string | undefined, log?: ReapLogger): number {
  const parsed = rawValue === undefined ? NaN : Number(rawValue);

  // Unset / unparseable / non-positive → fall back to the documented default.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return AUDIT_RETENTION_DEFAULT_MONTHS;
  }

  // Floor-clamp. A misconfig BELOW the regulatory floor is corrected, never
  // honoured — the warning makes the override visible in the logs without
  // letting it take effect.
  if (parsed < AUDIT_RETENTION_FLOOR_MONTHS) {
    log?.warn('audit retention below regulatory floor — clamping up', {
      configured_months: parsed,
      floor_months: AUDIT_RETENTION_FLOOR_MONTHS,
    });
    return AUDIT_RETENTION_FLOOR_MONTHS;
  }

  // At or above the floor: honour the operator's value (rounded down to a
  // whole month — fractional months are meaningless for a retention window).
  return Math.floor(parsed);
}

/**
 * Default delete batch size. Each loop iteration deletes at most this many
 * rows in its own short transaction, keeping locks brief on a large table.
 * 5_000 is a balance: large enough that a multi-year backlog drains in a
 * handful of iterations, small enough that a single statement stays fast and
 * never holds a long lock. Injectable for tests.
 */
export const AUDIT_RETENTION_BATCH_SIZE = 5_000 as const;

export interface PruneAuditLogOptions {
  /** Raw configured window (AUDIT_RETENTION_MONTHS). Resolved + floor-clamped
   *  via {@link resolveRetentionMonths}. */
  readonly rawRetentionMonths?: string | undefined;
  /** Rows deleted per batch. Defaults to {@link AUDIT_RETENTION_BATCH_SIZE}. */
  readonly batchSize?: number;
  /** Safety cap on loop iterations so a pathological state (e.g. churn
   *  matching the predicate faster than we delete) can never spin forever.
   *  Default high enough to drain any realistic backlog; a hit is logged. */
  readonly maxBatches?: number;
}

export interface PruneAuditLogResult {
  /** The EFFECTIVE window applied (post floor-clamp), in months. */
  readonly effectiveRetentionMonths: number;
  /** Total audit_log rows deleted across all batches. */
  readonly deleted: number;
  /** Number of delete batches executed. */
  readonly batches: number;
  /** True if the maxBatches safety cap was reached (older rows may remain;
   *  the next scheduled run continues draining). */
  readonly hitBatchCap: boolean;
}

/**
 * Delete `audit_log` rows OLDER than the effective retention window, in
 * bounded batches, on the BYPASSRLS maintenance pool.
 *
 * The cutoff is computed SERVER-SIDE as `now() - (months || ' months')` so
 * the predicate is anchored on the DB clock (no app/DB clock-skew window) and
 * the effective months value is the floor-clamped one — a row younger than 24
 * months can never match, by construction.
 *
 * Returns a summary for observability/evidence. Never reads or returns row
 * content. Throws only on a structural failure (pool down, role lost
 * BYPASSRLS) — the caller decides whether that should fail the scheduled job.
 */
export async function pruneAuditLog(
  log: ReapLogger,
  opts: PruneAuditLogOptions = {},
): Promise<PruneAuditLogResult> {
  const months = resolveRetentionMonths(opts.rawRetentionMonths, log);
  const batchSize = opts.batchSize ?? AUDIT_RETENTION_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? 10_000;

  // The cutoff interval. `months` is an integer we computed (never user
  // input), interpolated as a value into a `make_interval` call so there is
  // no string concatenation into the SQL text.
  const cutoffPredicate = sql`created_at < now() - make_interval(months => ${months})`;

  let deleted = 0;
  let batches = 0;
  let hitBatchCap = false;

  // Loop: delete one bounded chunk per iteration until a chunk comes back
  // smaller than the batch size (the backlog is drained) or we hit the cap.
  // `id IN (SELECT id ... LIMIT n)` keeps each statement bounded and lets the
  // planner use the created_at index for the inner scan.
  for (;;) {
    if (batches >= maxBatches) {
      hitBatchCap = true;
      log.warn('audit retention prune hit batch cap (will continue next run)', {
        batches,
        deleted,
        effective_retention_months: months,
      });
      break;
    }

    const statement = sql`
      DELETE FROM ${sql.identifier('audit_log')}
      WHERE id IN (
        SELECT id FROM ${sql.identifier('audit_log')}
        WHERE ${cutoffPredicate}
        LIMIT ${batchSize}
      )
    `;
    const result = await providerDb.execute(statement);
    const chunk = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    deleted += chunk;
    batches += 1;

    // A partial (or empty) chunk means no more rows match — we're done.
    if (chunk < batchSize) break;
  }

  log.info('audit retention prune complete', {
    effective_retention_months: months,
    deleted,
    batches,
    hit_batch_cap: hitBatchCap,
  });

  return { effectiveRetentionMonths: months, deleted, batches, hitBatchCap };
}
