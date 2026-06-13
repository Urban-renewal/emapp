/**
 * PII-safe scrub for Postgres error chains (shared by the API exception filter
 * and the worker observability seam — Theme-C dedup of the S1/S2 scrubs).
 *
 * A node-postgres error attaches a `cause` chain whose `detail`/`hint` fields
 * carry column VALUES — e.g. `Key (national_id)=(123456789) already exists`.
 * That is PII that must NEVER leave the boundary (root CLAUDE.md): before an
 * error is handed to an EXTERNAL service (Sentry), those values must be removed.
 * The pg `code` (SQLSTATE like `23505`) is PII-safe and is collected for context.
 *
 * This lives in @emapp/db because the shape it scrubs (`cause.detail`/`hint`) is
 * a Postgres concern, and both apps already depend on @emapp/db. It takes NO
 * Sentry dependency — callers do the capture; this only makes the error safe.
 *
 * FAIL-CLOSED: `scrubbed` is `false` if any `delete` could not complete (e.g. a
 * frozen/sealed `cause` object makes `delete` throw in strict mode). Callers
 * MUST NOT forward an error to Sentry when `scrubbed` is `false` — dropping the
 * event is correct; leaking unscrubbed `detail`/`hint` is not. The function
 * itself never throws.
 */
export interface PgScrubResult {
  /** PII-safe SQLSTATE codes collected from the cause chain (e.g. '23505'). */
  pgCodes: string[];
  /** false if any detail/hint could not be deleted → caller must not capture. */
  scrubbed: boolean;
}

/** Walk the error's `cause` chain (depth-bounded), DELETE `detail`/`hint` from
 *  each level in place, and collect the SQLSTATE codes. Mutates `err` in place.
 *  Never throws; reports `scrubbed: false` if a delete failed. */
export function scrubPgErrorPii(err: unknown): PgScrubResult {
  const pgCodes: string[] = [];
  let scrubbed = true;
  let cause: unknown = (err as { cause?: unknown } | null | undefined)?.cause;
  let depth = 0;
  while (cause && depth < 5) {
    const c = cause as { code?: unknown; detail?: unknown; hint?: unknown; cause?: unknown };
    if (typeof c.code === 'string') pgCodes.push(c.code);
    try {
      delete c.detail;
      delete c.hint;
    } catch {
      // Frozen/sealed cause — could not remove the PII fields. Fail closed:
      // the caller must drop the Sentry event rather than risk a leak.
      scrubbed = false;
    }
    cause = c.cause;
    depth += 1;
  }
  return { pgCodes, scrubbed };
}
