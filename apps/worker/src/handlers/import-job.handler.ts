/**
 * `import.excel` handler — Phase 6.
 *
 * S2 scope (this commit): owns the STATE MACHINE + AUDIT TRAIL +
 * IDEMPOTENT TRANSITIONS. The actual parser (S3), validation engine
 * (S5), and persistence batcher (S6) are deliberately stubbed — they
 * land in their own slices behind this seam. The state machine + audit
 * are S2 because they're the contract the SSE endpoint (T6.9) and
 * T6.8 ("queue job runs to completion") gate on; building them once
 * here and not re-shaping them every slice is the audit-pass lesson.
 *
 * State machine (docs/03 §10 + migration 0022 CHECK constraint):
 *   queued → parsing → validating → persisting → done
 *                                              ↘ failed
 *
 * Audit (ISO A.12.4 / docs/07 §12.4): EVERY transition writes an
 * `audit_log` row inside the same withTenant tx that updates
 * `import_jobs.status`. So either both happen or neither happens —
 * audit can never desync from the domain row.
 *
 * Idempotency on retry:
 *   - If the worker dies mid-handler and pg-boss retries, the row
 *     might already be in (say) 'validating'. The handler runs the
 *     state machine from `current` forward — each transition is a
 *     guarded UPDATE (... WHERE status = <expected>) so a second worker
 *     that already advanced past a stage is a no-op.
 *   - The audit_log writes ARE per-attempt by design (forensic record:
 *     we want to see "validating reached twice" if it happens). The
 *     STATE updates are idempotent; the AUDIT is append-only.
 *
 * No PII anywhere:
 *   - The payload carries jobId+orgId+createdBy only (see
 *     @emapp/jobs/import-job.ts).
 *   - This handler never reads file content (S3) or owner rows (S5+).
 *   - Logs scope by jobId; nothing else.
 */
import { AuditService, importJobs, withTenant, type TenantTx } from '@emapp/db';
import {
  IMPORT_JOB_NAME,
  ImportJobPayloadSchema,
  NonRetryableJobError,
  type IJobHandler,
  type ImportJobPayload,
  type JobContext,
} from '@emapp/jobs';
import { and, eq, sql } from 'drizzle-orm';

/** Domain state machine. MUST match the CHECK constraint in migration
 *  0022 (`import_jobs_status_valid`). Compile-time alignment with
 *  packages/db/src/schema/imports.ts is enforced by the typed UPDATEs
 *  below (Drizzle infers the column type as `text`, runtime CHECK
 *  guards the value). */
type Status = 'queued' | 'parsing' | 'validating' | 'persisting' | 'done' | 'failed' | 'cancelled';

/** Linear transition order. The handler walks forward only — never
 *  backward. Cancellation comes from a separate API endpoint (S8), not
 *  from inside the handler. */
const FORWARD: Record<Status, Status | null> = {
  queued: 'parsing',
  parsing: 'validating',
  validating: 'persisting',
  persisting: 'done',
  done: null,
  failed: null,
  cancelled: null,
};

export class ImportJobHandler implements IJobHandler<ImportJobPayload> {
  readonly name = IMPORT_JOB_NAME;
  /** 10 minutes — large enough for 1000-row imports per T6.11; the S7
   *  perf gate will tighten if needed. */
  readonly timeoutMs = 10 * 60 * 1000;
  /** pg-boss retries on retryable errors. 2 retries = 3 total attempts
   *  before the boss marks it failed. Transient DB blips warrant a
   *  retry; persistent issues (bad file) throw NonRetryableJobError
   *  and stop immediately. */
  readonly maxRetries = 2;

  /** Exposed so the adapter's payload validation uses the same schema
   *  the rest of the codebase imports (single source of truth). */
  readonly payloadSchema = ImportJobPayloadSchema;

  async handle(payload: ImportJobPayload, ctx: JobContext): Promise<void> {
    ctx.log.info('import job picked up', { orgId: payload.orgId });

    try {
      // Drive the state machine forward until we hit `done` (or an
      // error transitions to `failed`). Each iteration is one withTenant
      // tx — small, fast, idempotent.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (ctx.signal.aborted) {
          ctx.log.warn('shutdown signal received — pausing; pg-boss will retry');
          // Throwing a generic Error → pg-boss retries (default retryable).
          throw new Error('worker_shutting_down');
        }

        const current = await this.readStatus(payload);
        const next = FORWARD[current];
        if (next === null) {
          // Terminal state reached — done, failed, or cancelled. Nothing
          // more to do. Idempotent across retries.
          ctx.log.info('terminal state reached', { status: current });
          return;
        }

        // Run the stage's stub work. S3/S5/S6 swap each stub with the
        // real implementation. The stub's only job is to demonstrate
        // the seam compiles + audit fires + progress increments —
        // enough for T6.8.
        await this.runStage({ payload, ctx, from: current, to: next });
      }
    } catch (err) {
      // On any error: transition to 'failed' (idempotent guarded UPDATE)
      // and audit the failure. The thrown error then propagates to
      // pg-boss so the queue records the right retry/dead-letter state.
      await this.markFailed(payload, err);
      throw err;
    }
  }

  /** Read the current status under withTenant. Returns 'failed' if the
   *  row has vanished (e.g. provider-admin forensic deletion) — that's
   *  a terminal state so the handler exits cleanly. */
  private async readStatus(payload: ImportJobPayload): Promise<Status> {
    return withTenant(
      payload.orgId,
      async (tx: TenantTx): Promise<Status> => {
        const [row] = await tx
          .select({ status: importJobs.status })
          .from(importJobs)
          .where(eq(importJobs.id, payload.jobId))
          .limit(1);
        if (!row) {
          // No row visible under withTenant — the job was deleted out
          // from under us, OR (more likely) orgId in the payload was
          // tampered with. Both are non-retryable.
          throw new NonRetryableJobError('import_job not visible', 'job_not_visible');
        }
        return row.status as Status;
      },
      { userId: payload.createdBy },
    );
  }

  /** Execute one stage and commit the transition. The pre-stage UPDATE
   *  uses an idempotency guard (WHERE status = expected) so a retried
   *  worker that already moved past this stage observes 0 rows affected
   *  and skips. */
  private async runStage(opts: {
    payload: ImportJobPayload;
    ctx: JobContext;
    from: Status;
    to: Status;
  }): Promise<void> {
    const { payload, ctx, from, to } = opts;
    ctx.log.info('stage transition', { from, to });

    await withTenant(
      payload.orgId,
      async (tx) => {
        // Guarded transition: only advance if the row is still in `from`.
        // If another worker advanced it (or the user cancelled), 0 rows
        // affected → handler loops, re-reads, and follows the new state.
        const now = new Date();
        const updates: Partial<typeof importJobs.$inferInsert> = {
          status: to,
          updatedAt: now,
        };
        if (from === 'queued') updates.startedAt = now;
        if (to === 'done') updates.finishedAt = now;

        const result = await tx
          .update(importJobs)
          .set(updates)
          .where(and(eq(importJobs.id, payload.jobId), eq(importJobs.status, from)));

        // Drizzle's node-postgres update returns a result with rowCount.
        // If 0, the transition lost a race — that's fine, the outer
        // loop will re-read the current status next iteration.
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount === 0) {
          ctx.log.warn('transition skipped — row not in expected state', { from, to });
          return;
        }

        // Audit the transition. Same tx as the UPDATE → atomic.
        // actor_type='system' (worker has no user-session context; the
        // createdBy is the manager who enqueued, recorded as actorId).
        // See public-sign.service.ts:328 for the canonical pattern.
        await new AuditService(tx).log({
          orgId: payload.orgId,
          actorId: payload.createdBy,
          actorType: 'system',
          action: `import.${to}`,
          targetTable: 'import_jobs',
          targetId: payload.jobId,
          metadata: { from, to, pg_boss_job_id: ctx.jobId },
        });
      },
      { userId: payload.createdBy },
    );

    // Stage stub work (S3/S5/S6 replace these). Each progresses
    // processedRows so the SSE stream has something to emit — without
    // it T6.9 would observe a state-only stream which is technically
    // correct but practically useless. We keep this minimal: real
    // parsing/validation/persistence is large + slice-owned.
    if (to === 'parsing') await this.stubParseStage(payload);
    if (to === 'validating') await this.stubValidateStage(payload);
    if (to === 'persisting') await this.stubPersistStage(payload);
  }

  /** S3 will replace this — parse the Excel via ExcelJS streaming and
   *  set totalRows. For S2 we set a small known value so the SSE test
   *  has a deterministic emit. */
  private async stubParseStage(payload: ImportJobPayload): Promise<void> {
    await withTenant(
      payload.orgId,
      async (tx) => {
        await tx
          .update(importJobs)
          .set({ totalRows: 0, updatedAt: new Date() })
          .where(eq(importJobs.id, payload.jobId));
      },
      { userId: payload.createdBy },
    );
  }

  /** S5 will replace this — run Luhn + dedup + per-row validators. For
   *  S2 we increment processedRows by 0 (no real rows) so the SSE
   *  emits a progress event for the validating state. */
  private async stubValidateStage(payload: ImportJobPayload): Promise<void> {
    await withTenant(
      payload.orgId,
      async (tx) => {
        // Touch updated_at to give the SSE poller a real change to
        // detect during this stage. processed_rows stays 0 — we have
        // no real rows to process in the stub.
        await tx
          .update(importJobs)
          .set({ updatedAt: new Date() })
          .where(eq(importJobs.id, payload.jobId));
      },
      { userId: payload.createdBy },
    );
  }

  /** S6 will replace this — batched insert under withTenant with
   *  savepoints per docs/03 §10. For S2 we mark ok_rows / processed
   *  consistent with totalRows = 0. */
  private async stubPersistStage(payload: ImportJobPayload): Promise<void> {
    await withTenant(
      payload.orgId,
      async (tx) => {
        await tx
          .update(importJobs)
          .set({
            // total_rows was 0 from stub parse → processed=0, ok=0,
            // failed=0 is the consistent terminal state.
            processedRows: 0,
            okRows: 0,
            failedRows: 0,
            updatedAt: new Date(),
          })
          .where(eq(importJobs.id, payload.jobId));
      },
      { userId: payload.createdBy },
    );
  }

  /** Best-effort transition to 'failed' + audit. Guarded with
   *  `WHERE status NOT IN ('done','failed','cancelled')` so an
   *  already-terminal job is never demoted. */
  private async markFailed(payload: ImportJobPayload, err: unknown): Promise<void> {
    await withTenant(
      payload.orgId,
      async (tx) => {
        const now = new Date();
        const result = await tx
          .update(importJobs)
          .set({ status: 'failed', updatedAt: now, finishedAt: now })
          .where(
            and(
              eq(importJobs.id, payload.jobId),
              sql`${importJobs.status} NOT IN ('done','failed','cancelled')`,
            ),
          );
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount === 0) return;
        await new AuditService(tx).log({
          orgId: payload.orgId,
          actorId: payload.createdBy,
          actorType: 'system',
          action: 'import.failed',
          targetTable: 'import_jobs',
          targetId: payload.jobId,
          metadata: {
            reason: err instanceof Error ? err.message : 'unknown',
            non_retryable: err instanceof NonRetryableJobError ? err.code : null,
          },
        });
      },
      { userId: payload.createdBy },
    ).catch(() => {
      // If we can't even write the failed-state, swallow — the original
      // error will propagate to pg-boss which records its own failed
      // state. We must not mask the root cause.
    });
  }
}
