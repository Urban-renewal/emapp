/**
 * Signature-request expiry sweep — V12 slice-1 critic follow-up
 * (the `sweep:signature-expiry` periodic job's domain logic).
 *
 * Migration 0063 widened the signature_requests status CHECK to admit
 * 'expired' and one-shot-backfilled the already-lapsed rows — but rows
 * that lapse AFTER that migration stay 'pending' forever (the app paths
 * only ever DERIVE expiry from `expires_at`, they never persist it).
 * This module flips lapsed pending rows to 'expired' on a schedule
 * driven by the worker's pg-boss cron, so DB state agrees with the
 * derived truth.
 *
 * ── Why the BYPASSRLS maintenance pool (`providerDb`), NOT withTenant /
 *    withProvider ───────────────────────────────────────────────────
 * Same documented, bounded exception as `reapExpiredRows` /
 * `pruneAuditLog` (see reap-expired-rows.ts for the full rationale):
 * this is a SYSTEM cross-org sweep — withTenant(orgId) is per-org and
 * physically cannot see the whole table; withProvider expects a human
 * Provider-Admin principal + per-access audit. The correct principal is
 * the BYPASSRLS connecting role behind `providerDb`.
 *
 * ── Audit convention (differs from the reaper on purpose) ──────────
 * The reaper/retention jobs delete EPHEMERAL rows and only LOG — but
 * this sweep mutates DOMAIN forensic rows, so it writes ONE audit_log
 * row PER AFFECTED ORG: actor_type='system' (actor_id NULL = system,
 * per the schema comment), action='signature_request.expired_sweep',
 * metadata {count: <integer flips for that org>}. A run that flips 0
 * rows for an org writes NO audit row — audit_log is append-only +
 * 24-month-immutable (migration 0060), so daily empty-sweep noise would
 * be forever.
 *
 * ── Atomicity ──────────────────────────────────────────────────────
 * ONE SQL statement: the bulk UPDATE, the per-org grouping, and the
 * per-org audit INSERT are CTEs of a single statement, so the flips and
 * their audit evidence commit (or fail) together — no window where rows
 * flipped but the audit trail is missing.
 *
 * NO PII / row content in logs or audit metadata: integer counts only.
 * jti / owner_id / document_id / request ids are never read out of the
 * UPDATE (RETURNING org_id only) and never logged.
 */
import { sql } from 'drizzle-orm';

import { providerDb } from '../client';

/** Audit action written once per affected org per sweep run. */
export const SIGNATURE_EXPIRY_SWEEP_AUDIT_ACTION = 'signature_request.expired_sweep' as const;

export interface SignatureExpirySweepResult {
  /** Total rows flipped pending → expired across ALL orgs this run. */
  readonly expired: number;
  /** Number of distinct orgs that had at least one flip (== audit rows written). */
  readonly orgsAffected: number;
}

/**
 * Flip every lapsed pending signature_request (status='pending' AND
 * expires_at <= now()) to status='expired', and write the per-org system
 * audit row for each affected org. Nothing else on the rows changes;
 * signed / cancelled / already-expired / still-live pending rows are
 * untouched by the predicate. Idempotent — a second immediate run
 * matches 0 rows and writes 0 audit rows.
 */
export async function sweepExpiredSignatureRequests(): Promise<SignatureExpirySweepResult> {
  // Single atomic statement (data-modifying CTEs execute exactly once):
  //   flipped — the bulk UPDATE, RETURNING org_id ONLY (no PII, no ids).
  //   grouped — per-org flip counts.
  //   (audit INSERT) — one system audit row per affected org; zero-flip
  //   orgs simply aren't in `grouped`, so no noise rows.
  const result = await providerDb.execute(sql`
    WITH flipped AS (
      UPDATE signature_requests
         SET status = 'expired'
       WHERE status = 'pending'
         AND expires_at <= now()
      RETURNING org_id
    ),
    grouped AS (
      SELECT org_id, count(*)::int AS flip_count
        FROM flipped
       GROUP BY org_id
    ),
    audited AS (
      INSERT INTO audit_log (org_id, actor_type, action, metadata)
      SELECT org_id,
             'system',
             ${SIGNATURE_EXPIRY_SWEEP_AUDIT_ACTION},
             jsonb_build_object('count', flip_count)
        FROM grouped
      RETURNING org_id
    )
    SELECT coalesce(sum(flip_count), 0)::int AS expired,
           count(*)::int AS orgs_affected
      FROM grouped
  `);

  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
  const summary = rows[0] ?? {};
  const expired = typeof summary['expired'] === 'number' ? summary['expired'] : 0;
  const orgsAffected = typeof summary['orgs_affected'] === 'number' ? summary['orgs_affected'] : 0;

  return { expired, orgsAffected };
}
