/**
 * pg-boss ↔ IJobHandler adapter.
 *
 * The ONLY file in the codebase that knows about pg-boss types. Every
 * other worker file talks to `IJobHandler<T>` (from @emapp/jobs).
 *
 * Why this separation matters (audit-pass finding pre-S2): without it
 * the handler logic would be bound to pg-boss callback shape — and a
 * future swap (or even a unit test) would need pg-boss running. With it:
 *   - Handlers are pure async functions; testable with a FakeJobContext.
 *   - This adapter is the seam: register pg-boss `work()` once per
 *     handler, parse the payload through the handler's Zod schema, and
 *     fan out to handler.handle().
 *
 * Structural typing of `BossLike`: we don't import the runtime pg-boss
 * class here — we depend on the minimal surface (`createQueue`, `work`,
 * `start`, `stop`). main.ts wires the real pg-boss; unit tests pass a
 * fake. This is the Liskov boundary that lets us assert adapter
 * behaviour without a live Postgres queue.
 */
import { isNonRetryable, type IJobHandler, type JobContext, type JobLogger } from '@emapp/jobs';
import type { z } from 'zod';

import { captureWorkerException } from './observability';

/** Minimal pg-boss surface this adapter consumes. Matches the v10 API
 *  shape we use (createQueue, work, start, stop). */
export interface BossLike {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; close?: boolean; wait?: boolean }): Promise<void>;
  createQueue(name: string, options?: Record<string, unknown>): Promise<void>;
  work<T>(
    name: string,
    options: Record<string, unknown>,
    handler: (jobs: { id: string; data: T }[]) => Promise<unknown>,
  ): Promise<string>;
}

/** A handler registration that owns its own Zod schema. The adapter
 *  validates inbound payloads against this schema BEFORE invoking the
 *  handler — so handler.handle() sees only well-formed `TPayload`. */
export interface HandlerRegistration<TPayload> {
  readonly handler: IJobHandler<TPayload>;
  readonly payloadSchema: z.ZodType<TPayload>;
}

/** Wire a handler into pg-boss. Idempotent (createQueue on an existing
 *  queue is a no-op in pg-boss v10). Returns the pg-boss worker id so
 *  the caller can offWork() it on graceful shutdown if needed.
 *
 *  Lifecycle inside the batch callback:
 *    1. pg-boss delivers `batchSize: 1` job (we keep batches at 1 for
 *       Phase 6 — the parser is the slow step, not the queue overhead,
 *       and per-job audit + state-machine is much simpler to reason about).
 *    2. Validate payload (Zod). On failure → NonRetryable: a malformed
 *       payload won't fix itself. Throwing forwards to pg-boss as a
 *       permanent failure (no retry).
 *    3. Construct JobContext (logger scoped, abort signal wired to the
 *       shared shutdown signal).
 *    4. Call handler.handle(payload, ctx). On success → return; pg-boss
 *       marks the job completed. On NonRetryableJobError → rethrow with
 *       a marker so the boss skips retries. On any other Error → rethrow
 *       as-is so pg-boss retries per its retry policy. */
export async function registerHandler<TPayload>(opts: {
  boss: BossLike;
  registration: HandlerRegistration<TPayload>;
  log: JobLogger;
  /** Shared AbortSignal — fired by the SIGTERM handler so in-flight
   *  jobs can drain. Adapter wires this through to JobContext.signal. */
  signal: AbortSignal;
  /** Optional concurrency override. Default 1 — Phase 6 import is
   *  CPU-bound in the parser; concurrency tuning is an S7 perf gate
   *  (T6.10/T6.11), not S2. */
  concurrency?: number;
}): Promise<string> {
  const { boss, registration, log, signal } = opts;
  const { handler, payloadSchema } = registration;

  // Create the queue first. In pg-boss v10 this is required before
  // .work() if no producer has called .send() yet on a fresh DB.
  await boss.createQueue(handler.name, {
    retryLimit: handler.maxRetries,
    // pg-boss expireInSeconds = "kill the job if it runs longer than X".
    // We surface our timeoutMs (in seconds) so a stuck handler doesn't
    // hold the slot forever.
    expireInSeconds: Math.max(1, Math.floor(handler.timeoutMs / 1000)),
  });

  return boss.work<TPayload>(
    handler.name,
    {
      batchSize: 1,
      // v4 audit fix (HIGH forensic observability): pg-boss only
      // exposes `retryCount` on the job object when includeMetadata
      // is true. Pre-fix, every audit_log row carried `attempt='1'`
      // regardless of which retry it was — an SRE diagnosing a
      // thrashing job from logs alone CANNOT distinguish attempt 1
      // from attempt 5. Now we read job.retryCount per invocation
      // and plumb it through ctx.attempt → audit_log.metadata.
      includeMetadata: true,
      teamConcurrency: opts.concurrency ?? 1,
      // v4 audit fix (P0 perf): pg-boss v10 defaults
      // newJobCheckInterval to 2000ms on the worker side — every
      // customer waits ~2s after upload before the worker reads
      // the queue. Per Lidor's customer-onboarding posture
      // "אם לקוח יחכה איבדנו אותו" this is the literal first 2s
      // of avoidable wait. 200ms feels instant on the SSE side;
      // batchSize:1 + teamConcurrency:1 bound the extra DB chatter
      // on Free Tier.
      newJobCheckInterval: 200,
    },
    async (jobs) => {
      // batchSize:1 guarantees `jobs.length <= 1`, but we still defend
      // against shape drift from pg-boss across minor versions.
      for (const job of jobs) {
        await runOne({ job, handler, payloadSchema, log, signal });
      }
    },
  );
}

/** pg-boss v10 with includeMetadata: true augments the job shape with
 *  retryCount (and other metadata fields). We narrow to what we use. */
interface PgBossJobWithMeta {
  id: string;
  data: unknown;
  retryCount?: number;
}

async function runOne<TPayload>(opts: {
  job: PgBossJobWithMeta;
  handler: IJobHandler<TPayload>;
  payloadSchema: z.ZodType<TPayload>;
  log: JobLogger;
  signal: AbortSignal;
}): Promise<void> {
  const { job, handler, payloadSchema, log, signal } = opts;
  const jobId = job.id;
  // v4 audit fix: read the retry count pg-boss provides via
  // includeMetadata. retryCount is 0-indexed (first run = 0) so we
  // add 1 to match the "attempt number" mental model that the audit
  // schema uses. Defensive fallback to 1 if pg-boss ever drops the
  // field (cross-minor-version shape drift).
  const attempt = typeof job.retryCount === 'number' ? job.retryCount + 1 : 1;

  // Per-invocation logger meta. Includes service+jobId so log aggregation
  // (Railway/Sentry) can correlate every line for a given job.
  const scopedLog: JobLogger = {
    info: (msg, meta) => log.info(msg, { jobId, attempt, ...meta }),
    warn: (msg, meta) => log.warn(msg, { jobId, attempt, ...meta }),
    error: (msg, meta) => log.error(msg, { jobId, attempt, ...meta }),
  };

  // Validate the payload. Failure here is PERMANENT — a malformed
  // payload is not going to fix itself across retries. Log STRUCTURAL
  // info only (issue paths + count) — never the raw error message and
  // never the payload data. Zod v3 does not echo values in messages by
  // default, but tampered payloads MIGHT have stringy values whose name
  // shows up in `received: '<value>'` for some checks. Defense in depth:
  // we own what enters our logs (audit-pass S2 finding M1).
  let payload: TPayload;
  try {
    payload = payloadSchema.parse(job.data);
  } catch (err) {
    const issuePaths =
      err instanceof Error &&
      'issues' in err &&
      Array.isArray((err as { issues: unknown[] }).issues)
        ? (err as { issues: Array<{ path?: Array<string | number> }> }).issues
            .map((i) => (i.path ?? []).join('.'))
            .slice(0, 8)
        : [];
    scopedLog.error('payload validation failed — non-retryable', {
      issue_count: issuePaths.length,
      issue_paths: issuePaths,
    });
    // pg-boss has no native "non-retryable" flag at handler-throw time;
    // we rely on retryLimit being respected AND on the handler tagging
    // its own state in import_jobs (the domain row is the source of
    // truth — pg-boss's own state is just queue plumbing).
    throw err;
  }

  const ctx: JobContext = { jobId, attempt, log: scopedLog, signal };

  try {
    await handler.handle(payload, ctx);
  } catch (err) {
    if (isNonRetryable(err)) {
      scopedLog.error('handler reported non-retryable error', {
        code: err.code,
        reason: err.message,
      });
    } else {
      scopedLog.error('handler error (retryable)', {
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
    // S2 — a failing job is now VISIBLE in Sentry (PII-safe capture scrubs the
    // pg cause detail/hint), not just a log line that may not reach it.
    captureWorkerException(err, { jobName: handler.name, jobId, attempt });
    throw err;
  }
}
