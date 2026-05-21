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
  apartments,
  buildings,
  encryptOwnerPii,
  importJobErrors,
  importJobs,
  owners,
  ownerships,
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
import { ExcelParserError, parseExcelFull, type ParsedRows } from '../parser/excel.parser';
import { summariseFailureForAudit } from '../security/audit-sanitiser';
import { validateRow } from '../validation/row-validator';

/** A validated row that passed S5 row-validator. The canonical fields
 *  are extracted + trimmed; persistStage (S6) consumes this shape. */
interface ValidatedRow {
  /** 1-indexed source row in the Excel (for forensic mapping). */
  rowNumber: number;
  nationalId: string;
  phone: string;
  name: string;
  apartmentNumber: string;
  buildingAddress: string;
  /** Already parsed to a number (0..100). null when the column was
   *  unmapped or empty — persistStage applies the default (100 for
   *  a single owner, error if multi-owner without explicit pct). */
  ownershipPct: number | null;
}

/** Per-`handle()` cache so parseStage's parsed rows are reused by
 *  validateStage instead of being re-downloaded + re-parsed.
 *
 *  Audit-pass v2 finding L6: a clean run wasted ~1-2s on the double
 *  R2 GET + ExcelJS load. The cache cuts that to one read per job.
 *
 *  Scope: ONE per `handler.handle(...)` invocation — created at the
 *  top of handle() and dropped on return. Survives across stages
 *  WITHIN one attempt; does NOT persist across pg-boss retries (a
 *  retry is a fresh handle() call → empty cache → validateStage
 *  re-downloads, which is the correct restart-from-scratch posture). */
interface JobCache {
  parsed?: ParsedRows;
  mapping?: ColumnMapping;
  /** Rows that passed validation (S5). persistStage (S6) consumes
   *  these to build the owners + apartments + buildings + ownerships
   *  trees. Populated by validateStage. */
  okRows?: ValidatedRow[];
}

/** Domain state machine. MUST match the CHECK constraint in migration
 *  0022 (`import_jobs_status_valid`). Compile-time alignment with
 *  packages/db/src/schema/imports.ts is enforced by the typed UPDATEs
 *  below (Drizzle infers the column type as `text`, runtime CHECK
 *  guards the value). */
type Status = 'queued' | 'parsing' | 'validating' | 'persisting' | 'done' | 'failed' | 'cancelled';

/** Extract a row's canonical-field values from the parsed cell vector,
 *  given the resolved mapping. Returns a ValidatedRow ready for S6's
 *  persistence pipeline. The mapping has already been confirmed
 *  complete by resolveMapping, so the required canonicals all have
 *  column indexes. */
function extractValidatedRow(
  row: string[],
  rowNumber: number,
  mapping: ColumnMapping,
): ValidatedRow {
  const get = (col: number | undefined): string =>
    col !== undefined ? (row[col] ?? '').trim() : '';
  const pctCol = mapping.columns.ownership_pct;
  let ownershipPct: number | null = null;
  if (pctCol !== undefined) {
    const raw = get(pctCol);
    if (raw !== '') {
      const parsed = Number(raw.replace('%', ''));
      if (Number.isFinite(parsed)) ownershipPct = parsed;
    }
  }
  return {
    rowNumber,
    nationalId: get(mapping.columns.national_id).padStart(9, '0'),
    phone: get(mapping.columns.phone),
    name: get(mapping.columns.name),
    apartmentNumber: get(mapping.columns.apartment_number),
    buildingAddress: get(mapping.columns.building_address),
    ownershipPct,
  };
}

/** Find-or-create a building row keyed by (project, address). Caches
 *  results in `cache` so a multi-row import that all targets one
 *  building does one SELECT + one INSERT (max) across all rows. */
async function findOrCreateBuilding(
  tx: TenantTx,
  projectId: string,
  address: string,
  cache: Map<string, string>,
): Promise<string> {
  const hit = cache.get(address);
  if (hit) return hit;

  const [existing] = await tx
    .select({ id: buildings.id })
    .from(buildings)
    .where(
      and(
        eq(buildings.projectId, projectId),
        eq(buildings.address, address),
        sql`${buildings.archivedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (existing) {
    cache.set(address, existing.id);
    return existing.id;
  }

  // City is required (NOT NULL). The import file has no city column
  // in the MVP mapping; default to a sentinel that the Manager can
  // edit via the buildings UI. S8's wizard could pre-fill from
  // project metadata; that's a UX improvement, not an S6 blocker.
  const [created] = await tx
    .insert(buildings)
    .values({ projectId, address, city: '-' })
    .returning({ id: buildings.id });
  if (!created) throw new Error('failed to insert building');
  cache.set(address, created.id);
  return created.id;
}

/** Find-or-create an apartment keyed by (building, number). */
async function findOrCreateApartment(
  tx: TenantTx,
  buildingId: string,
  number: string,
  cache: Map<string, string>,
): Promise<string> {
  const key = `${buildingId}${number}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const [existing] = await tx
    .select({ id: apartments.id })
    .from(apartments)
    .where(
      and(
        eq(apartments.buildingId, buildingId),
        eq(apartments.number, number),
        sql`${apartments.archivedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }

  const [created] = await tx
    .insert(apartments)
    .values({ buildingId, number })
    .returning({ id: apartments.id });
  if (!created) throw new Error('failed to insert apartment');
  cache.set(key, created.id);
  return created.id;
}

/** Find-or-create an owner keyed by (org_id, national_id_hash). PII
 *  is encrypted via pgcrypto + HMAC-hashed via D.12 helpers. Cross-
 *  import dedup is RESOLVED here: a second import with the same
 *  national_id reuses the existing owner row.  */
async function findOrCreateOwner(
  tx: TenantTx,
  orgId: string,
  row: ValidatedRow,
  cache: Map<string, string>,
): Promise<string> {
  const piiEnc = await encryptOwnerPii(tx, {
    nationalId: row.nationalId,
    phone: row.phone,
  });
  const cached = cache.get(piiEnc.nationalIdHash);
  if (cached) return cached;

  const [existing] = await tx
    .select({ id: owners.id })
    .from(owners)
    .where(
      and(
        eq(owners.orgId, orgId),
        eq(owners.nationalIdHash, piiEnc.nationalIdHash),
        sql`${owners.archivedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (existing) {
    cache.set(piiEnc.nationalIdHash, existing.id);
    return existing.id;
  }

  const [created] = await tx
    .insert(owners)
    .values({
      orgId,
      name: row.name,
      nationalIdEncrypted: piiEnc.nationalIdEncrypted,
      nationalIdHash: piiEnc.nationalIdHash,
      phoneEncrypted: piiEnc.phoneEncrypted,
      phoneHash: piiEnc.phoneHash,
    })
    .returning({ id: owners.id });
  if (!created) throw new Error('failed to insert owner');
  cache.set(piiEnc.nationalIdHash, created.id);
  return created.id;
}

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

    // Per-attempt cache — see JobCache JSDoc.
    const cache: JobCache = {};

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

        await this.runStage({ payload, ctx, from: current, to: next, cache });
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
    cache: JobCache;
  }): Promise<void> {
    const { payload, ctx, from, to, cache } = opts;
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
    if (to === 'parsing') await this.parseStage(payload, ctx, cache);
    if (to === 'validating') await this.validateStage(payload, ctx, cache);
    if (to === 'persisting') await this.persistStage(payload, ctx, cache);
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
  private async parseStage(
    payload: ImportJobPayload,
    ctx: JobContext,
    cache: JobCache,
  ): Promise<void> {
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

    // Audit-pass v2 finding L6: parseStage USED to call
    // parseExcelHeader (header + rowCount only) and validateStage
    // re-downloaded + re-parsed via parseExcelFull. That cost ~1-2s
    // wasted from the T6.10 45s budget per 100-row job.
    //
    // Now parseStage runs parseExcelFull and caches the result in the
    // per-attempt JobCache so validateStage reuses it. Memory delta is
    // tiny vs the cost saved (typical 1000-row import = ~300KB of
    // string[][], 100x cheaper than the R2 round-trip + decompression).
    let parsed: ParsedRows;
    try {
      const stream = await this.storage.getObjectStream(row.fileR2Key);
      parsed = await parseExcelFull(stream);
    } catch (e: unknown) {
      if (e instanceof ExcelParserError) {
        throw new NonRetryableJobError(`parse failed: ${e.code}`, `parse_${e.code}`);
      }
      throw e;
    }

    // S4 — fail-fast mapping check (T6.2). Cache it for validateStage.
    let mapping: ColumnMapping;
    try {
      mapping = resolveMapping(parsed.headers);
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

    cache.parsed = parsed;
    cache.mapping = mapping;

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
  private async validateStage(
    payload: ImportJobPayload,
    ctx: JobContext,
    cache: JobCache,
  ): Promise<void> {
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

    // L6: prefer the per-attempt cache (parseStage in this same
    // handle() invocation already paid for the R2 GET + ExcelJS load).
    // Falls back to re-download for the retry path: pg-boss restart
    // mid-flight reads `current='validating'` and the cache is empty
    // because handle() is fresh. The fallback preserves correctness
    // (a retry MUST be self-contained) at the cost of duplicating the
    // download — same posture as before L6, just now ONLY on retry.
    let parsed: ParsedRows;
    let mapping: ColumnMapping;

    if (cache.parsed && cache.mapping) {
      parsed = cache.parsed;
      mapping = cache.mapping;
      ctx.log.info('validateStage using cached parse result');
    } else {
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
      try {
        const stream = await this.storage.getObjectStream(row.fileR2Key);
        parsed = await parseExcelFull(stream);
      } catch (e: unknown) {
        if (e instanceof ExcelParserError) {
          throw new NonRetryableJobError(`parse failed: ${e.code}`, `parse_${e.code}`);
        }
        throw e;
      }
      try {
        mapping = resolveMapping(parsed.headers);
      } catch (e: unknown) {
        if (e instanceof MappingError) {
          throw new NonRetryableJobError(`mapping failed: ${e.code}`, `mapping_${e.code}`);
        }
        throw e;
      }
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
    const okRows: ValidatedRow[] = [];

    for (let i = 0; i < parsed.rows.length; i += 1) {
      const result = validateRow(parsed.rows[i]!, parsed.rowNumbers[i]!, mapping, seenIds);
      if (result.ok) {
        okCount += 1;
        // S6 — cache the validated row's canonical-extracted shape so
        // persistStage doesn't have to re-extract from the raw row.
        okRows.push(extractValidatedRow(parsed.rows[i]!, parsed.rowNumbers[i]!, mapping));
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

    // Cache the validated rows for persistStage (S6).
    cache.okRows = okRows;

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

  /** S6 — real persistence (closes T6.6 + T6.7).
   *
   *  Materialises validated rows into the domain model:
   *    1. Resolve / find-or-create one building per unique
   *       (project_id, address) — buildings.city defaults to a
   *       sentinel '-' until the wizard adds a city column.
   *    2. Resolve / find-or-create one apartment per unique
   *       (building_id, number).
   *    3. For each ok row: encrypt PII (pgcrypto via encryptOwnerPii)
   *       and find-or-create the owner by national_id_hash.
   *    4. Per apartment, atomically set-replace ownerships (D.25):
   *       end any active ownership rows, insert the new set. The
   *       DEFERRABLE INITIALLY DEFERRED sum-check trigger fires at
   *       COMMIT; per-apartment sums must total exactly 100 (or 0
   *       if zero rows). The handler refuses to advance an apartment
   *       whose imported rows don't sum to 100.
   *
   *  Everything inside ONE withTenant transaction so the constraint
   *  trigger sees a consistent state. Idempotent on pg-boss retry:
   *    - find-or-create is naturally idempotent.
   *    - ownership set-replace is idempotent (end + insert with the
   *      same percentages = same final state).
   *
   *  Dry-run path (T6.5): persistStage early-exits when
   *  import_jobs.dry_run = true. Validation already produced the
   *  errors the manager needs; the persist stage just transitions
   *  cleanly to done.
   *
   *  T6.5 ("Dry-run no DB change"): when import_jobs.dry_run = true,
   *  we explicitly DON'T touch the owner-domain tables. Validation
   *  already produced errors so the manager sees exactly what WOULD
   *  happen; the persist stage just transitions cleanly to done. */
  private async persistStage(
    payload: ImportJobPayload,
    ctx: JobContext,
    cache: JobCache,
  ): Promise<void> {
    const job = await withTenant(
      payload.orgId,
      async (tx) => {
        const [r] = await tx
          .select({
            dryRun: importJobs.dryRun,
            okRows: importJobs.okRows,
            projectId: importJobs.projectId,
          })
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

    // No project_id → can't materialise buildings. This is the
    // pre-S8 fallback (older tests / dev fixtures created import_jobs
    // rows without a project). S8's wizard enforces project_id at
    // POST /imports; production never hits this path.
    if (!job.projectId) {
      ctx.log.warn('persistStage skipped — import_jobs.project_id is null (S6 stub)');
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

    // No validated rows in cache → nothing to persist. Either the
    // file had zero ok rows, OR this is a retry where validateStage
    // didn't run in this attempt (handler resumed at 'persisting').
    // We don't auto-recover by re-validating here — that's a deep
    // re-fetch path. Instead, treat empty cache.okRows as "nothing
    // to do", touch updated_at, advance. If a retry needs persistence,
    // the operator restarts the job from 'queued'.
    const okRows = cache.okRows ?? [];
    if (okRows.length === 0) {
      ctx.log.info('persistStage no rows to persist (cache miss or empty validation)', {
        cache_present: cache.okRows !== undefined,
      });
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

    const { projectId } = job;
    // Group rows by apartment-key (address + number). Each group
    // becomes one apartment in the DB; the group's rows become its
    // ownership set.
    const apartmentGroups = new Map<string, ValidatedRow[]>();
    for (const r of okRows) {
      const key = `${r.buildingAddress}${r.apartmentNumber}`;
      const list = apartmentGroups.get(key);
      if (list) list.push(r);
      else apartmentGroups.set(key, [r]);
    }

    // Validate per-apartment ownership percentages before any write:
    //  - single owner: pct defaults to 100 if null.
    //  - multi owner: every row must have explicit pct; sum must == 100.
    const apartmentPctErrors: string[] = [];
    for (const [key, rows] of apartmentGroups) {
      if (rows.length === 1) continue; // single-owner path handles itself
      const pcts = rows.map((r) => r.ownershipPct);
      if (pcts.some((p) => p === null)) {
        apartmentPctErrors.push(
          `apartment '${key.replace('', ' #')}' has multiple owners but a row is missing ownership_pct`,
        );
        continue;
      }
      const sum = pcts.reduce<number>((s, p) => s + (p ?? 0), 0);
      if (Math.abs(sum - 100) > 0.01) {
        apartmentPctErrors.push(
          `apartment '${key.replace('', ' #')}' ownership percentages sum to ${sum}, expected 100`,
        );
      }
    }
    if (apartmentPctErrors.length > 0) {
      throw new NonRetryableJobError(
        `persistence rejected: ${apartmentPctErrors[0]}`,
        'persist_ownership_sum_invalid',
      );
    }

    // Resolve unique buildings + apartments + owners (3 maps). All
    // writes happen in a single withTenant tx so the deferred sum
    // trigger (D.25) sees a consistent state at COMMIT.
    await withTenant(
      payload.orgId,
      async (tx) => {
        // Build the building cache: one entry per unique address.
        const buildingByAddress = new Map<string, string>();
        const apartmentByKey = new Map<string, string>();
        const ownerByHash = new Map<string, string>();

        for (const [, rows] of apartmentGroups) {
          const first = rows[0]!;
          const buildingId = await findOrCreateBuilding(
            tx,
            projectId,
            first.buildingAddress,
            buildingByAddress,
          );
          const apartmentId = await findOrCreateApartment(
            tx,
            buildingId,
            first.apartmentNumber,
            apartmentByKey,
          );

          // For each row in this apartment group, resolve the owner.
          const ownersForApt: Array<{ ownerId: string; pct: number }> = [];
          for (const r of rows) {
            const ownerId = await findOrCreateOwner(tx, payload.orgId, r, ownerByHash);
            const pct = rows.length === 1 ? (r.ownershipPct ?? 100) : (r.ownershipPct ?? 0);
            ownersForApt.push({ ownerId, pct });
          }

          // Atomic set-replace (D.25): end any currently-active
          // ownerships for this apartment, then insert the new set.
          const now = new Date();
          await tx
            .update(ownerships)
            .set({ endedAt: now })
            .where(
              and(eq(ownerships.apartmentId, apartmentId), sql`${ownerships.endedAt} IS NULL`),
            );
          for (const o of ownersForApt) {
            await tx.insert(ownerships).values({
              apartmentId,
              ownerId: o.ownerId,
              ownershipPct: String(o.pct),
            });
          }
        }

        // Touch updated_at so SSE sees a final tick.
        await tx
          .update(importJobs)
          .set({ updatedAt: new Date() })
          .where(eq(importJobs.id, payload.jobId));
      },
      { userId: payload.createdBy },
    );

    ctx.log.info('persistence complete', {
      apartments: apartmentGroups.size,
      ok_rows: okRows.length,
    });
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
