/**
 * `IJobProducer` — the single abstraction for enqueueing background jobs.
 *
 * Why this exists (Phase 6 S8): the API (apps/api) needs to enqueue
 * jobs after the FE confirms an R2 upload. Without this abstraction
 * the API would import pg-boss directly, coupling controller code to
 * the queue tech and making the producer untestable without a real
 * pg-boss instance. Mirrors the IJobHandler pattern on the consume
 * side — pg-boss types live in exactly one adapter file per app.
 *
 * Tests inject a `FakeJobProducer` (collects sends in an array, never
 * touches the queue). Production wires `PgBossJobProducer` via DI.
 *
 * Idempotency:
 *   - `singletonKey` (optional) is pg-boss's per-queue dedup key. When
 *     supplied, a second send with the same singletonKey IS a no-op
 *     while the first is still active. Used for "user clicks Start
 *     twice" guards on the imports API.
 *
 * Security:
 *   - The job payload MUST NOT carry PII. The producer interface only
 *     types the payload generically; the per-job-type Zod schema (see
 *     ImportJobPayloadSchema) is the enforcement seam.
 *   - The producer adapter MUST use the same DB pool as the worker
 *     (PROVIDER_DATABASE_URL / BYPASSRLS) — pg-boss's job table is in
 *     its own schema and not RLS-protected (queue plumbing, not
 *     customer data).
 */

/** Per-send options. All optional — most callers just supply payload. */
export interface JobSendOptions {
  /** pg-boss singleton key — when set, dedups concurrent sends of the
   *  same key while one is in-flight. Useful for "user double-clicked
   *  the Start button" idempotency at the API layer. */
  readonly singletonKey?: string;
  /** Override the per-job retry limit for this send. Defaults to the
   *  handler's `maxRetries`. */
  readonly retryLimit?: number;
}

/** Result of a successful enqueue. */
export interface JobSendResult {
  /** pg-boss-assigned job id. Mirror in `import_jobs.pg_boss_job_id`
   *  if you want a forensic correlation between the domain row and
   *  the queue row. Can be null when pg-boss skips a send due to a
   *  singletonKey collision (treat as "already enqueued"). */
  readonly id: string | null;
}

/** Enqueue a single job onto the queue. Payload is opaque to the
 *  producer — callers MUST validate against the job's Zod schema
 *  before calling. */
export interface IJobProducer {
  send<TPayload>(name: string, payload: TPayload, opts?: JobSendOptions): Promise<JobSendResult>;
}
