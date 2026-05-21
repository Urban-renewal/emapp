/**
 * Audit-metadata sanitiser — strips PII before an error lands in
 * `audit_log.metadata`.
 *
 * Background (audit-pass v2 finding C2, HIGH):
 *   `audit_log.metadata` is a jsonb column queryable by any Manager
 *   with the `audit:read` policy grant (D.17 / D.26). When a pg-error
 *   (unique-violation, FK-violation, CHECK-violation) is raised by
 *   Drizzle, `err.message` typically includes the offending row VALUES
 *   — e.g. `duplicate key value violates unique constraint
 *   "owners_org_natid_unique_active": Key (national_id_hash)=(<hash>)
 *   already exists.`. While our owners table uses HMAC hashes (the
 *   hash itself isn't reversible PII), `phone_hash` collisions or
 *   future error paths could echo cleartext PII, AND the pg-pool error
 *   guard (D.29 PoolErrorEvent) already forwards err.message bytes —
 *   we must not extend that surface to audit storage.
 *
 *   docs/07 §5 forbids PII in error messages. The fix is structural:
 *   reduce a thrown error to a value-free record before audit.
 *
 * Posture:
 *   - Class name (`Error.name`) is ALWAYS safe — it's a program
 *     identifier, set at code-author time, never echoes input.
 *   - NonRetryableJobError carries a `.code` discriminator we author
 *     (e.g. `parse_corrupt_file`, `mapping_incomplete`). Always safe.
 *   - For drizzle/pg errors we surface ONLY `code` (pg's SQLSTATE
 *     `'23505'` / `'23514'` / etc.) and `constraint` (the constraint
 *     name like `owners_org_natid_unique_active`) — both program-
 *     identifier-level, never row values.
 *   - We DO NOT include `.detail`, `.hint`, `.where`, or any free-form
 *     string from pg. Those are the leak vector.
 *
 *   The full err.message + stack still lives in the worker's pino logs
 *   (pino's redact config strips obvious fields; the surface there is
 *   smaller than queryable audit_log).
 */
import { NonRetryableJobError, isNonRetryable } from '@emapp/jobs';

/** Shape pg / pg-error / DatabaseError ducks-typed. */
interface PgErrorLike {
  /** SQLSTATE (5-char code) — '23505' = unique-violation etc. */
  code?: string;
  /** Constraint name when applicable — author-controlled identifier. */
  constraint?: string;
}

/** Indexable shape — AuditEntry.metadata expects Record<string,
 *  unknown>; we declare the index signature so the struct is
 *  assignable without an `as unknown` dance. */
export interface FailureAuditSummary {
  [key: string]: string | null;
  /** Error class name. Always present; defaults to 'Unknown'. */
  error_class: string;
  /** Application-level non-retryable code (parse_<x>, mapping_<x>,
   *  job_not_visible). null when the failure was a retryable Error. */
  non_retryable_code: string | null;
  /** pg SQLSTATE — when the failure was an underlying pg error. */
  pg_code: string | null;
  /** pg constraint name — when applicable. */
  pg_constraint: string | null;
}

export function summariseFailureForAudit(err: unknown): FailureAuditSummary {
  const summary: FailureAuditSummary = {
    error_class: 'Unknown',
    non_retryable_code: null,
    pg_code: null,
    pg_constraint: null,
  };

  if (err instanceof Error) {
    summary.error_class = err.name;
  }
  if (isNonRetryable(err)) {
    summary.non_retryable_code = (err as NonRetryableJobError).code;
  }

  // Drizzle wraps pg errors and chains the original via `.cause`. Walk
  // the cause chain a bounded depth, harvesting SQLSTATE + constraint
  // ONLY (never .detail / .hint / .where — those carry values).
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    const pg = cur as PgErrorLike;
    if (typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
      summary.pg_code = pg.code;
    }
    if (typeof pg.constraint === 'string' && pg.constraint.length <= 128) {
      summary.pg_constraint = pg.constraint;
    }
    cur = (cur as { cause?: unknown })?.cause;
    depth += 1;
  }

  return summary;
}
