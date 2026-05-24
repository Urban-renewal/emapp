/**
 * Worker payload tamper-verification — v8 P0 security (§v7-A closure).
 *
 * Background — the trust problem
 * -------------------------------
 * pg-boss carries an opaque JSON payload alongside every queued job.
 * Both the producer (`apps/api`) and the consumer (`apps/worker`) talk
 * to pg-boss via the BYPASSRLS provider pool — pg-boss needs to manage
 * its own schema (`pgboss.job`) which isn't under RLS, and the producer
 * INSERT must work pre-authorization in the worker process.
 *
 * That means the producer is the ONLY thing standing between
 * "Manager-supplied input" and "what the worker trusts." A bug, an
 * unauthenticated worker boot, or a future Provider-Admin tool that
 * lets ops re-queue a job could enqueue a row with:
 *
 *   payload = { jobId: '<victim-org's job UUID>',
 *               orgId: '<attacker-org UUID>',
 *               createdBy: '<any UUID>' }
 *
 * If the worker blindly uses `payload.orgId` for `withTenant(...)`, RLS
 * is set to the ATTACKER org for every downstream read. The
 * `withTenant`'s `SELECT * FROM import_jobs WHERE id = payload.jobId`
 * would then either (a) return nothing (job belongs to victim org → not
 * visible under attacker RLS — current safety net via "vanished
 * mid-parse" NonRetryable), OR (b) MATCH if the attacker first created
 * their own job under their own org with the same id (UUID collision is
 * astronomical so this is theoretical).
 *
 * Either way the current behaviour is correct ONLY because the RLS
 * policy on `import_jobs` filters by `org_id = current_setting(...)`.
 * That's a one-line-from-broken defence: a future migration that
 * accidentally widens the policy (e.g. for a Provider Admin "see
 * everything" feature) would silently lift the safety net.
 *
 * Design — defence in depth
 * -------------------------
 * Read `(org_id, created_by)` directly from `import_jobs` via the
 * BYPASSRLS pool (providerDb). Compare org_id against payload.orgId.
 *
 *   - Match → return the DB-attested `(orgId, createdBy)`.
 *   - Mismatch → throw NonRetryableJobError (poisoned payload — retry
 *     won't help; ops must investigate).
 *   - Not found → throw NonRetryableJobError (job vanished or was
 *     never inserted — same outcome as today, just earlier).
 *
 * The verified values flow back as the SINGLE source of truth for the
 * rest of the handler. `payload.*` MUST NOT be read again in this
 * invocation; lint via the discriminator type below (`VerifiedJobIdentity`).
 *
 * Why providerDb and not withProvider
 * -----------------------------------
 * `withProvider` REQUIRES a real Provider Admin UUID + a non-trivial
 * `reason` string + writes a row to `provider_audit_log` — that table
 * exists to evidence ACTUAL provider-tier access by EMAPP staff. The
 * worker is a system actor; mixing system reads into that audit table
 * pollutes the regulator-facing record. So we use `providerDb`
 * directly: BYPASSRLS but no provider_audit_log fingerprint.
 *
 * What we audit instead
 * ---------------------
 * Mismatch fires NonRetryable + ctx.log.error + (the caller may add)
 * a `import.payload_rejected` audit row scoped to the verified org if
 * we can identify it. The choice we make here: NO audit row when
 * verifiedOrgId disagrees with payload.orgId, because we don't know
 * which org to scope it to. ctx.log.error is the only signal — that's
 * acceptable because (a) Sentry catches the log, (b) the row stays in
 * pgboss.job with the rejection metadata, and (c) the legitimate
 * import for the victim org is unaffected (it's still queued under its
 * own jobId and a future re-enqueue picks it up).
 */
import { importJobs, providerDb } from '@emapp/db';
import type { ImportJobPayload } from '@emapp/jobs';
import { eq } from 'drizzle-orm';

/** Brand the verified shape so the handler can't accidentally use
 *  `payload.orgId` after verification. ESLint can't enforce this
 *  directly without a custom rule, but the structural mismatch is
 *  enough to make a "read payload.orgId here" diff stand out in code
 *  review. */
export interface VerifiedJobIdentity {
  /** Was the payload's `orgId` faithful? */
  readonly verified: true;
  /** The org_id read from the DB row — use for EVERY downstream
   *  withTenant call. */
  readonly orgId: string;
  /** The created_by read from the DB row — use as the audit actor. */
  readonly createdBy: string;
}

/** Thrown when the payload's `orgId` doesn't match the DB row's
 *  `org_id` (poisoned producer), or when the row is missing entirely. */
export class JobPayloadTamperedError extends Error {
  readonly code = 'job_payload_tampered' as const;
  constructor(
    readonly jobId: string,
    readonly reason: 'org_mismatch' | 'row_missing',
  ) {
    // Keep the message PII-free — only UUIDs + the discriminator.
    super(`job payload rejected (${reason}, jobId=${jobId})`);
    this.name = 'JobPayloadTamperedError';
  }
}

/**
 * Verify a payload at worker handler entry.
 *
 * @throws JobPayloadTamperedError when the payload's orgId doesn't
 *   match the DB row, OR when the row is missing.
 */
export async function verifyJobPayload(payload: ImportJobPayload): Promise<VerifiedJobIdentity> {
  const [row] = await providerDb
    .select({ orgId: importJobs.orgId, createdBy: importJobs.createdBy })
    .from(importJobs)
    .where(eq(importJobs.id, payload.jobId))
    .limit(1);

  if (!row) {
    throw new JobPayloadTamperedError(payload.jobId, 'row_missing');
  }
  if (row.orgId !== payload.orgId) {
    throw new JobPayloadTamperedError(payload.jobId, 'org_mismatch');
  }
  return {
    verified: true,
    orgId: row.orgId,
    createdBy: row.createdBy,
  };
}
