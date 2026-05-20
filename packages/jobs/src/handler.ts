/**
 * `IJobHandler` — the single abstraction for background-job processors.
 *
 * Why this exists (audit-pass finding pre-S2): without it, the worker
 * would couple pg-boss callbacks directly to domain logic — making each
 * job impossible to unit-test (you'd need to spin up pg-boss + a DB
 * just to assert "did the validator reject row 5?"). With it:
 *   - Handlers are pure async functions of (payload, ctx) → void.
 *   - pg-boss is the only consumer that knows about pg-boss types.
 *   - Future job types (export, notifications) plug in via the same
 *     interface — no S6 rewrite when Phase 7 lands.
 *
 * Liskov: every IJobHandler is substitutable. A test can pass a
 * `FakeJobContext` and assert the handler's side-effects without ever
 * touching the queue.
 *
 * Errors:
 *   - Throw from `handle()` ⇒ pg-boss retries per its retry policy.
 *     The handler MUST be idempotent across retries (the
 *     `import_jobs.idempotency_key` UNIQUE index is one such guard).
 *   - Return normally ⇒ job completed; pg-boss marks it done.
 *   - For a transition like queued → parsing → validating, EACH state
 *     change is committed inside withTenant before yielding back to
 *     pg-boss — so a mid-handler crash leaves the row in a recoverable
 *     state, not in limbo.
 */

/** Logger surface every handler can use. Intentionally minimal —
 *  matches what pino/console expose without binding to either. */
export interface JobLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Per-invocation context passed to every handler. Created by the
 *  worker runtime (pg-boss adapter) and threaded into the call. */
export interface JobContext {
  /** pg-boss job id — written to `import_jobs.pg_boss_job_id` for
   *  forensic correlation between the queue and the domain row. */
  readonly jobId: string;
  /** 1-indexed retry attempt (1 = first try, 2 = first retry, ...). */
  readonly attempt: number;
  /** Structured logger scoped to this invocation. Worker injects
   *  `service`, `jobId`, `attempt` automatically. */
  readonly log: JobLogger;
  /** AbortSignal — fires on SIGTERM. Handlers SHOULD periodically
   *  check `signal.aborted` between heavy steps so a graceful
   *  shutdown actually drains in time. */
  readonly signal: AbortSignal;
}

/** A background-job handler. `TPayload` is the typed shape the queue
 *  delivers — Zod-validated by the worker BEFORE calling `handle`,
 *  so the handler sees only well-formed input.
 *
 *  Implementations register themselves with the worker's pg-boss
 *  adapter (the only place that knows the queue's API). */
export interface IJobHandler<TPayload> {
  /** Job name registered with pg-boss. MUST be unique across the
   *  worker and stable across deploys (changing it strands in-flight
   *  jobs). Use namespaced strings like `import.excel`. */
  readonly name: string;

  /** Maximum invocation runtime. Worker will abort the AbortSignal
   *  after this many ms; pg-boss will re-queue with attempt+1.
   *  Default reasonable for the import flow: 10min (file parse +
   *  validate + batched persist of 1000 rows fits comfortably). */
  readonly timeoutMs: number;

  /** Maximum retries before sending to dead-letter. pg-boss's own
   *  retry count drives this; the handler just states intent here. */
  readonly maxRetries: number;

  /** Do the work. Throw on retryable failure; throw a
   *  `NonRetryableJobError` (see ./errors.ts) on permanent failure
   *  to bypass retry. Return normally on success. */
  handle(payload: TPayload, ctx: JobContext): Promise<void>;
}
