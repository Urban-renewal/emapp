/**
 * Worker observability — PII-safe Sentry capture (audit slice S2).
 *
 * The worker had NO real Sentry: a thrown import/reaper/signature-expiry job, or
 * a process crash, was invisible in Sentry (only a log line that may or may not
 * reach it). `captureWorkerException` is the single seam the crash handlers
 * (bootstrap.ts) and the pg-boss job wrapper (pg-boss-adapter.ts) call so a
 * worker fault surfaces in the alerting tool.
 *
 * PII SAFETY: a pg error's `cause.detail` / `cause.hint` carry column VALUES
 * (e.g. `Key (national_id)=(…)`) — PII that must never leave the boundary (root
 * CLAUDE.md). We scrub those off the WHOLE cause chain IN PLACE before handing
 * the error to Sentry (external); the pgcode + top-level message + stack are
 * PII-safe and kept so Sentry keeps real grouping/diagnosis. The full error is
 * still in the worker's pino logs (with PII redaction) for forensics.
 *
 * The PII scrub itself is the shared `scrubPgErrorPii` from @emapp/db (Theme-C —
 * one implementation, one test surface, also used by the API exception filter).
 * This function adds the worker-specific context tags + never-throw wrapping.
 */
import { scrubPgErrorPii } from '@emapp/db';
import * as Sentry from '@sentry/node';

export interface WorkerErrorContext {
  jobName?: string;
  jobId?: string;
  attempt?: number;
}

export function captureWorkerException(err: unknown, context: WorkerErrorContext = {}): void {
  // NEVER THROW: observability must not break the thing it observes. This is
  // called from the crash handlers right before `exit(1)` (D.29 — the process
  // MUST exit so Railway restarts it); if the scrub or Sentry threw and was
  // unguarded, a fault would HANG instead of restarting. We also FAIL CLOSED on
  // PII: if the scrub can't complete (e.g. a frozen `cause` makes `delete`
  // throw in strict mode), we drop the Sentry event rather than risk capturing
  // unscrubbed detail/hint.
  try {
    // Scrub pg cause.detail/hint (PII) before the external capture, via the
    // shared @emapp/db helper (Theme-C — one implementation, one test surface).
    // Fail closed: if it could not scrub (frozen cause), drop the event.
    const { pgCodes, scrubbed } = scrubPgErrorPii(err);
    if (!scrubbed) return;

    const tags: Record<string, string | number> = {};
    if (context.jobName) tags.jobName = context.jobName;
    if (context.jobId) tags.jobId = context.jobId;
    if (typeof context.attempt === 'number') tags.attempt = context.attempt;

    Sentry.captureException(err, {
      level: 'error',
      tags,
      ...(pgCodes.length > 0 ? { contexts: { pg: { codes: pgCodes } } } : {}),
    });
  } catch {
    // Swallow — never propagate an observability failure to the caller, and
    // never capture an error we couldn't fully scrub (fail-closed on PII).
  }
}
