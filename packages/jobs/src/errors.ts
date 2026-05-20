/**
 * Job-error discriminators.
 *
 * `Error` thrown from a handler is RETRYABLE by default — pg-boss
 * re-queues with attempt+1. That's the right default for transient
 * failures (DB blip, R2 hiccup, OOM-then-restart).
 *
 * Some failures are PERMANENT — retrying just burns budget:
 *   - Validation failed on a file the manager uploaded (the file
 *     itself is wrong; no amount of retry fixes it)
 *   - Idempotency-Key already consumed (the work was done)
 *   - Resource gone (org deleted between enqueue and execute)
 *
 * Throw `NonRetryableJobError` to mark the failure permanent so
 * pg-boss skips retries and the worker writes the final `failed`
 * state to `import_jobs` immediately.
 */
export class NonRetryableJobError extends Error {
  override readonly name = 'NonRetryableJobError';
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** Type guard for the worker's pg-boss adapter to branch on. */
export function isNonRetryable(err: unknown): err is NonRetryableJobError {
  return err instanceof NonRetryableJobError;
}
