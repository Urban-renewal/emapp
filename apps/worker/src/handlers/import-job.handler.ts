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
import {
  AuditService,
  importJobErrors,
  importJobs,
  withTenant,
  type IStorageProvider,
  type TenantTx,
} from '@emapp/db';
import {
  IMPORT_JOB_NAME,
  ImportJobPayloadSchema,
  NonRetryableJobError,
  type IJobHandler,
  type ImportJobPayload,
  type JobContext,
} from '@emapp/jobs';
import { and, eq, sql } from 'drizzle-orm';

import { MappingError, resolveMapping, type ColumnMapping } from '../mapping/mapping';
import { ExcelParserError, parseExcelFull, parseExcelHeader } from '../parser/excel.parser';
import { summariseFailureForAudit } from '../security/audit-sanitiser';
import { validateRow } from '../validation/row-validator';

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

  /** S3 (this slice) injects IStorageProvider so the parser can read
   *  the uploaded file from R2 (Fake in dev/test). Optional so the
   *  pre-S3 test path (T6.8) still constructs `new ImportJobHandler()`
   *  with no args; if no provider, the parsing stage falls back to the
   *  S2 stub behaviour (totalRows = 0). Production main.ts always
   *  passes the real factory-built provider. */
  constructor(private readonly storage?: IStorageProvider) {}

  async handle(payload: ImportJobPayload, ctx: JobContext): Promise<void> {
    ctx.log.info('import job picked up', { orgId: payload.orgId });

    // Audit-pass v2 finding C5 (HIGH): the first audit row used to be
    // `import.parsing` — a regulator scanning audit_log saw jobs
    // springing into existence at parsing with no worker-side
    // provenance. Now we write `import.received` at handler entry,
    // BEFORE any state transition.
    //
    // Per-attempt (NOT deduped on retry): pg-boss retries ARE
    // forensically meaningful events — each retry indicates a prior
    // failure that warrants its own audit trail. metadata carries
    // ctx.attempt so the retry sequence is reconstructable.
    //
    // RLS visibility precondition: we only write the audit row if the
    // import_jobs row is visible under this withTenant scope (defense
    // against a tampered payload — if the orgId doesn't match the
    // job, the row won't be visible and we skip silently; readStatus
    // will then throw NonRetryable below).
    try {
      await withTenant(
        payload.orgId,
        async (tx) => {
          const existing = await tx
            .select({ id: importJobs.id })
            .from(importJobs)
            .where(eq(importJobs.id, payload.jobId))
            .limit(1);
          if (existing.length === 0) return;
          await new AuditService(tx).log({
            orgId: payload.orgId,
            actorId: payload.createdBy,
            actorType: 'system',
            action: 'import.received',
            targetTable: 'import_jobs',
            targetId: payload.jobId,
            metadata: { pg_boss_job_id: ctx.jobId, attempt: String(ctx.attempt) },
          });
        },
        { userId: payload.createdBy },
      );
    } catch (e: unknown) {
      // Audit write failure is non-fatal — log + continue. Better to
      // run the job than to refuse it because of an audit blip.
      ctx.log.warn('failed to write import.received audit row', {
        reason: e instanceof Error ? e.name : 'unknown',
      });
    }

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
    if (to === 'parsing') await this.parseStage(payload, ctx);
    if (to === 'validating') await this.validateStage(payload, ctx);
    if (to === 'persisting') await this.persistStage(payload, ctx);
  }

  /** S3 — real ExcelJS streaming parse. Reads `file_r2_key` from the
   *  domain row, streams bytes via IStorageProvider, detects the
   *  header row + counts data rows (T6.1), and writes totalRows back
   *  to the same import_jobs row. Without an IStorageProvider (the
   *  pre-S3 unit-test path, T6.8 baseline) this falls back to the S2
   *  stub semantics so existing tests keep passing.
   *
   *  Errors:
   *   - ExcelParserError (corrupt/sparse/formula-in-header) → wrapped
   *     as NonRetryableJobError so pg-boss skips retries and
   *     markFailed transitions the domain row to 'failed'.
   *   - Storage I/O error (R2 blip) → propagate as RETRYABLE; the
   *     boss's retry policy handles it. */
  private async parseStage(payload: ImportJobPayload, ctx: JobContext): Promise<void> {
    if (!this.storage) {
      // Pre-S3 fallback — keeps T6.8's bare `new ImportJobHandler()`
      // path running. Production main.ts always injects a provider.
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
      return;
    }

    const row = await withTenant(
      payload.orgId,
      async (tx) => {
        const [r] = await tx
          .select({ fileR2Key: importJobs.fileR2Key })
          .from(importJobs)
          .where(eq(importJobs.id, payload.jobId))
          .limit(1);
        return r;
      },
      { userId: payload.createdBy },
    );
    if (!row) {
      throw new NonRetryableJobError('import_job vanished mid-parse', 'job_not_visible');
    }

    let parsed;
    try {
      const stream = await this.storage.getObjectStream(row.fileR2Key);
      parsed = await parseExcelHeader(stream);
    } catch (e: unknown) {
      if (e instanceof ExcelParserError) {
        throw new NonRetryableJobError(`parse failed: ${e.code}`, `parse_${e.code}`);
      }
      // I/O error from storage — retryable; the boss handles.
      throw e;
    }

    // S4 — fail-fast mapping check (T6.2). Resolves canonical fields
    // from headers; the file is rejected here (before validation +
    // persistence) when required fields are missing or ambiguously
    // mapped. The resolved mapping itself is recomputed in S5 (it's a
    // pure function of headers; cheap to repeat) — we don't persist it
    // on the row in this slice.
    try {
      const mapping = resolveMapping(parsed.headers);
      ctx.log.info('mapping resolved', {
        bound: Object.keys(mapping.columns).length,
        unmapped: mapping.unmapped.length,
        ambiguous: mapping.ambiguous.length,
      });
    } catch (e: unknown) {
      if (e instanceof MappingError) {
        throw new NonRetryableJobError(`mapping failed: ${e.code}`, `mapping_${e.code}`);
      }
      throw e;
    }

    ctx.log.info('excel header detected', {
      header_cols: parsed.headers.length,
      data_rows: parsed.rowCount,
    });

    await withTenant(
      payload.orgId,
      async (tx) => {
        await tx
          .update(importJobs)
          .set({ totalRows: parsed.rowCount, updatedAt: new Date() })
          .where(eq(importJobs.id, payload.jobId));
      },
      { userId: payload.createdBy },
    );
  }

  /** S5 — validate every data row.
   *  Closes T6.3 (Luhn), T6.4 (in-file dedup). Iterates the file's
   *  data rows, applies the mapping (S4), runs validateRow per row,
   *  and inserts structured per-row errors into import_job_errors.
   *  Updates aggregate counters (processed_rows, ok_rows, failed_rows)
   *  on the parent import_jobs row.
   *
   *  No-provider path keeps the S2 stub behaviour (zero counters, no
   *  errors) so the legacy T6.8 baseline still passes.
   *
   *  T6.5 dry-run is NOT handled here — persistStage early-exits when
   *  dry_run=true. Validation always runs (dry-run shows the manager
   *  what WOULD happen — same errors, just no persistence). */
  private async validateStage(payload: ImportJobPayload, ctx: JobContext): Promise<void> {
    if (!this.storage) {
      await withTenant(
        payload.orgId,
        async (tx) => {
          await tx
            .update(importJobs)
            .set({ updatedAt: new Date() })
            .where(eq(importJobs.id, payload.jobId));
        },
        { userId: payload.createdBy },
      );
      return;
    }

    // Re-download + re-parse for full row data. Acceptable cost for
    // MVP (the storage read is bounded by 50MB; ExcelJS parse already
    // benchmarks <2s for the T6.10 100-row gate). S7 may add a cache
    // if the perf gate fails.
    const row = await withTenant(
      payload.orgId,
      async (tx) => {
        const [r] = await tx
          .select({ fileR2Key: importJobs.fileR2Key })
          .from(importJobs)
          .where(eq(importJobs.id, payload.jobId))
          .limit(1);
        return r;
      },
      { userId: payload.createdBy },
    );
    if (!row) {
      throw new NonRetryableJobError('import_job vanished mid-validate', 'job_not_visible');
    }

    let parsed;
    try {
      const stream = await this.storage.getObjectStream(row.fileR2Key);
      parsed = await parseExcelFull(stream);
    } catch (e: unknown) {
      if (e instanceof ExcelParserError) {
        throw new NonRetryableJobError(`parse failed: ${e.code}`, `parse_${e.code}`);
      }
      throw e;
    }

    let mapping: ColumnMapping;
    try {
      mapping = resolveMapping(parsed.headers);
    } catch (e: unknown) {
      if (e instanceof MappingError) {
        throw new NonRetryableJobError(`mapping failed: ${e.code}`, `mapping_${e.code}`);
      }
      throw e;
    }

    // Run validation across all rows. seenIds is per-import — T6.4
    // dedup is in-file only; cross-import duplicate detection would
    // need a different mechanism (likely a DB query under withTenant)
    // and is NOT part of T6.4's scope per docs/03 §10.
    const seenIds = new Set<string>();
    let okCount = 0;
    let failedCount = 0;
    const errorBatch: Array<{
      jobId: string;
      orgId: string;
      rowNumber: number;
      field: string | null;
      code: string;
      message: string;
    }> = [];

    for (let i = 0; i < parsed.rows.length; i += 1) {
      const result = validateRow(parsed.rows[i]!, parsed.rowNumbers[i]!, mapping, seenIds);
      if (result.ok) {
        okCount += 1;
      } else {
        failedCount += 1;
        for (const err of result.errors) {
          errorBatch.push({
            jobId: payload.jobId,
            orgId: payload.orgId,
            rowNumber: err.rowNumber,
            field: err.field,
            code: err.code,
            message: err.message,
          });
        }
      }
    }

    // Persist counters + errors atomically. Batch errors into one
    // INSERT — for typical 100-row imports with handful of errors this
    // is a single round-trip; for pathological all-fail cases the
    // batch fits well within Postgres parameter limits (each row has
    // 6 columns; 1000 rows = 6000 params, under the 65k limit).
    await withTenant(
      payload.orgId,
      async (tx) => {
        await tx
          .update(importJobs)
          .set({
            // overwrite (not add) — on pg-boss retry these reflect the
            // CURRENT validation pass, not an accumulation.
            processedRows: parsed.rows.length,
            okRows: okCount,
            failedRows: failedCount,
            updatedAt: new Date(),
          })
          .where(eq(importJobs.id, payload.jobId));
        if (errorBatch.length > 0) {
          // Audit-pass v2 finding C9 (MEDIUM): on pg-boss retry the
          // same row+code is recomputed; without ON CONFLICT DO
          // NOTHING the table would double up every error row on
          // every retry. Migration 0025 added the UNIQUE
          // (job_id, row_number, code) index; this clause uses it.
          await tx
            .insert(importJobErrors)
            .values(errorBatch)
            .onConflictDoNothing({
              target: [importJobErrors.jobId, importJobErrors.rowNumber, importJobErrors.code],
            });
        }
      },
      { userId: payload.createdBy },
    );

    ctx.log.info('validation complete', {
      processed: parsed.rows.length,
      ok: okCount,
      failed: failedCount,
    });
  }

  /** S6 will replace this — batched insert into owners/apartments/
   *  buildings under withTenant with savepoints per docs/03 §10. For
   *  S5 we early-exit when dry_run=true (T6.5) and otherwise no-op
   *  (real persistence ships in S6).
   *
   *  T6.5 ("Dry-run no DB change"): when import_jobs.dry_run = true,
   *  we explicitly DON'T touch the owner-domain tables. Validation
   *  already produced errors so the manager sees exactly what WOULD
   *  happen; the persist stage just transitions cleanly to done. */
  private async persistStage(payload: ImportJobPayload, ctx: JobContext): Promise<void> {
    const job = await withTenant(
      payload.orgId,
      async (tx) => {
        const [r] = await tx
          .select({ dryRun: importJobs.dryRun, okRows: importJobs.okRows })
          .from(importJobs)
          .where(eq(importJobs.id, payload.jobId))
          .limit(1);
        return r;
      },
      { userId: payload.createdBy },
    );

    if (!job) {
      throw new NonRetryableJobError('import_job vanished mid-persist', 'job_not_visible');
    }

    if (job.dryRun) {
      ctx.log.info('dry-run — persistence skipped (T6.5)', { ok: job.okRows });
      // No domain writes. Counters already final from validateStage.
      // Just touch updated_at so the SSE sees a tick.
      await withTenant(
        payload.orgId,
        async (tx) => {
          await tx
            .update(importJobs)
            .set({ updatedAt: new Date() })
            .where(eq(importJobs.id, payload.jobId));
        },
        { userId: payload.createdBy },
      );
      return;
    }

    // S6 lands the real persistence (batched owner/apartment/
    // building writes with savepoints). For S5 this is a no-op so
    // the existing T6.8 baseline keeps passing.
    await withTenant(
      payload.orgId,
      async (tx) => {
        await tx
          .update(importJobs)
          .set({ updatedAt: new Date() })
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
          // SECURITY (audit-pass v2 finding C2 — HIGH): err.message
          // for a pg-error (unique-violation / FK-violation / CHECK) can
          // include row VALUES — e.g. `Key (national_id)=(123456789)
          // already exists`. That row value would land in audit_log
          // (jsonb), queryable by any Manager with audit:read. PII via
          // audit is a docs/07 §5 violation. Strip to structured,
          // value-free fields: the error CLASS (always safe — class
          // names are program identifiers) + the NonRetryable code
          // (already a discriminator, never a value). The full pg-error
          // chain belongs only in the worker's pino logs (redacted).
          metadata: summariseFailureForAudit(err),
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
