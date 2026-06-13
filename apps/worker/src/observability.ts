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
 * NOTE (Theme C — duplication): this mirrors the API exception filter's S1
 * scrub (`apps/api/src/common/filters/http-exception.filter.ts`). A follow-up
 * slice should extract ONE shared PII-safe-capture helper both call.
 */
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
    // Scrub pg cause.detail/hint down the chain (depth-bounded), collecting the
    // PII-safe pgcode(s) for Sentry context as we go.
    const pgCodes: string[] = [];
    let cause: unknown = (err as { cause?: unknown })?.cause;
    let depth = 0;
    while (cause && depth < 5) {
      const c = cause as { code?: unknown; detail?: unknown; hint?: unknown; cause?: unknown };
      if (typeof c.code === 'string') pgCodes.push(c.code);
      delete c.detail;
      delete c.hint;
      cause = c.cause;
      depth += 1;
    }

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
