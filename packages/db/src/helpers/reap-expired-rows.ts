/**
 * Expired-row reaper — Phase 3 #5a (the FIRST periodic-maintenance
 * consumer). §v8-L5.
 *
 * The auth / OTP / cache tables accumulate rows that the application
 * already treats as DEAD the instant they expire (every read path
 * filters `expires_at < now()` or `revoked_at IS NOT NULL`), but nothing
 * ever DELETES them. Left alone they grow without bound — bloating the
 * tables, their indexes, and (for auth_sessions / tenant_sessions) the
 * forensic surface. This module deletes only genuinely-expired rows, on
 * a schedule driven by the worker's pg-boss cron.
 *
 * ── Why the BYPASSRLS maintenance pool (`providerDb`), NOT withTenant /
 *    withProvider ───────────────────────────────────────────────────
 * This is a SYSTEM cross-org cleanup, not tenant data access:
 *   - `withTenant(orgId)` is per-org and RLS-scoped — it physically
 *     cannot see other orgs' rows, so it could never reap the table in
 *     one pass (and auth_sessions / cache_kv aren't even org-scoped).
 *   - `withProvider(providerUserId, reason)` is for AUDITED human
 *     Provider-Admin access — it sets `app.provider_user_id` and expects
 *     a provider principal + an audit trail per access. A maintenance
 *     tick has no provider user and writes no per-row audit; forcing it
 *     through withProvider would fabricate a fake actor.
 *   - The correct principal is the BYPASSRLS connecting role behind
 *     `providerDb` (PROVIDER_DATABASE_URL) — the same documented, bounded
 *     exception the pg-boss queue plumbing and migrations already use
 *     (see migration 0050: "the RAW db connecting role ... has BYPASSRLS
 *     — by design"). RLS policies only constrain `app_user`; a system
 *     reaper is deliberately outside that boundary.
 *
 * ── Why the WHERE clauses are load-bearing ─────────────────────────
 * Each predicate must match ONLY expired rows and NEVER a live one. The
 * descriptor list below pins the EXACT predicate per table (grounded in
 * the schema). A `cache_kv` row is `expires_at NOT NULL` by schema, but
 * `expires_at < now()` excludes NULL regardless — a never-expiring row
 * could never be reaped even if the column became nullable later.
 *
 * ── Open/closed ────────────────────────────────────────────────────
 * Adding a table later is a one-line entry in REAP_TARGETS, not new
 * code. Each target is best-effort: a failure reaping one table logs and
 * continues so a lock/error on one table never strands the others.
 *
 * NO PII in logs: only the table name and an integer deleted-count per
 * table are logged. Row contents are never read or logged.
 */
import { sql } from 'drizzle-orm';

import { providerDb } from '../client';

/** Minimal logger surface — matches `JobLogger` (@emapp/jobs) without
 *  this package depending on it. The worker passes its pino-backed
 *  logger; tests pass a fake. */
export interface ReapLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * One reap target. `whereExpired` is a fully-formed SQL boolean fragment
 * that selects ONLY rows safe to delete. Keep it parameter-free and
 * `now()`-anchored so the predicate is self-contained and auditable here.
 */
export interface ReapTarget {
  /** Physical table name (also the log label). */
  readonly table: string;
  /** SQL predicate identifying expired rows. MUST exclude every live
   *  row. Anchored on the DB clock (`now()`), evaluated server-side. */
  readonly whereExpired: ReturnType<typeof sql>;
}

/**
 * The reap descriptor list — the SINGLE source of truth for "what counts
 * as expired" per table. Grounded in packages/db/src/schema:
 *
 *  - auth_sessions     (auth-sessions.ts): org refresh sessions. A row is
 *    dead once it is past `expires_at`. We DELETE strictly on expiry;
 *    revoked-but-not-yet-expired rows are intentionally KEPT until their
 *    natural expiry because the rotation/reuse-detection chain
 *    (`replaced_by`) needs the revoked row present to detect replay of a
 *    rotated token. Once `expires_at < now()` the replay window is closed
 *    and the row is pure dead weight.
 *  - tenant_sessions   (tenant-sessions.ts): Tenant-portal sessions.
 *    Same shape as auth_sessions; dead once past `expires_at`.
 *  - otp_codes         (otp.ts): SMS OTP store. `expires_at` is NOT NULL;
 *    a code past it can never be redeemed (consumed codes are also long
 *    past their short TTL). Reap on `expires_at < now()`.
 *  - cache_kv          (artifacts.ts): Postgres cache. `expires_at` is
 *    NOT NULL by schema, so there is no "never expires" (NULL) row to
 *    protect — but `< now()` excludes NULL anyway as a belt-and-braces
 *    guard should the column ever become nullable.
 *
 * EXCLUDED — notifications (collaboration.ts): the table has NO expiry
 * concept. Its only time columns are `read_at` (read-state) and
 * `created_at`. There is no TTL, so there is no correct "expired"
 * predicate to apply — deleting by read-state or by age would be
 * inventing a retention policy that the schema/spec does not define.
 * A notifications-retention rule, if ever wanted, is a separate product
 * decision and a new descriptor — NOT this slice.
 */
export const REAP_TARGETS: readonly ReapTarget[] = [
  { table: 'auth_sessions', whereExpired: sql`expires_at < now()` },
  { table: 'tenant_sessions', whereExpired: sql`expires_at < now()` },
  { table: 'otp_codes', whereExpired: sql`expires_at < now()` },
  { table: 'cache_kv', whereExpired: sql`expires_at < now()` },
];

/** Per-table outcome — `error` is set (and `deleted` left 0) when that
 *  table's DELETE failed; other targets still ran. */
export interface ReapTableResult {
  readonly table: string;
  readonly deleted: number;
  readonly error?: string;
}

export interface ReapResult {
  readonly results: readonly ReapTableResult[];
  /** Total rows deleted across every target that succeeded. */
  readonly totalDeleted: number;
  /** Count of targets whose DELETE threw (best-effort: the others ran). */
  readonly failures: number;
}

/**
 * Run the reaper over every target in {@link REAP_TARGETS} (or an
 * injected list, for tests). Each DELETE runs independently on the
 * BYPASSRLS maintenance pool; a failure on one table is logged and the
 * loop continues, so one bad table never aborts the rest. Returns a
 * per-table deleted-count summary for observability.
 *
 * Never throws for a per-table SQL error — those are captured into the
 * result. (The caller — the worker handler — decides whether a non-zero
 * `failures` count should fail the pg-boss job for retry.)
 */
export async function reapExpiredRows(
  log: ReapLogger,
  targets: readonly ReapTarget[] = REAP_TARGETS,
): Promise<ReapResult> {
  const results: ReapTableResult[] = [];
  let totalDeleted = 0;
  let failures = 0;

  for (const target of targets) {
    try {
      // Identifier is from the hard-coded REAP_TARGETS list (never user
      // input); the predicate is a static `now()`-anchored fragment. No
      // value interpolation, nothing to parameterise — but we still build
      // it via drizzle's `sql` template so the table name is a proper
      // identifier and the statement is prepared, not string-concatenated.
      const statement = sql`DELETE FROM ${sql.identifier(target.table)} WHERE ${target.whereExpired}`;
      const result = await providerDb.execute(statement);
      const deleted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
      totalDeleted += deleted;
      results.push({ table: target.table, deleted });
      log.info('reaped expired rows', { table: target.table, deleted });
    } catch (e: unknown) {
      failures += 1;
      // Message only — pg connection/SQL errors here are structural
      // (table name + clock predicate), no row content, no PII.
      const message = e instanceof Error ? e.message : 'unknown';
      results.push({ table: target.table, deleted: 0, error: message });
      log.error('reap failed for table (continuing)', { table: target.table, error: message });
    }
  }

  return { results, totalDeleted, failures };
}
