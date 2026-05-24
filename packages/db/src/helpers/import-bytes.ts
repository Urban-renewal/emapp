/**
 * Import bytes purger — v8.5 lift from apps/worker.
 *
 * Lives in @emapp/db now (was apps/worker) so both the worker terminal-
 * state path AND the API cancel() path can invoke it. v8.5 SOLID #4 +
 * Security cross-confirmed that the API cancel was BYPASSING the purge,
 * leaking PII bytes on the most-common terminal route.
 *
 * BACKGROUND
 *   Uploaded Excel files contain cleartext PII (national_id, phone,
 *   name, address). Pre-v8 they sat in R2 forever — no delete on any
 *   terminal state, no R2 lifecycle rule. Israeli privacy-law right-
 *   to-erasure + ISO A.18.1.4 data-minimisation both failed.
 *
 * STRATEGY
 *   Once a row reaches a terminal state (done / failed / cancelled),
 *   we no longer need the bytes for any worker operation:
 *     - `done`: persisted rows are encrypted in the domain tables;
 *       the original Excel is redundant.
 *     - `failed`: by definition no retry will succeed; the Manager
 *       must upload a NEW import to try again.
 *     - `cancelled`: the Manager already decided not to proceed.
 *
 *   `awaiting_mapping` is INTENTIONALLY skipped — that's a pause
 *   state, not terminal. The wizard / agent may resolve the mapping
 *   and re-enqueue; the worker will then re-read the bytes.
 *
 * IDEMPOTENCY
 *   The migration's CHECK constraint enforces "only terminal jobs
 *   can have file_deleted_at set." We guard at the SELECT side too:
 *   only purge rows where file_deleted_at IS NULL. A second purge
 *   call on an already-purged row is a no-op (rowCount=0).
 *
 *   Storage delete is idempotent at the R2 level — S3 DeleteObject
 *   returns 200 even if the key doesn't exist (we'd see a 404 only
 *   for invalid bucket / auth).
 *
 * FAILURE MODE
 *   If storage.delete fails (R2 outage, transient network), we DO
 *   NOT mark file_deleted_at — a future call will retry. The audit
 *   row records the FAILURE separately so SRE can see "we tried to
 *   purge X but R2 said no."
 */
import { and, eq, isNull } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service';
import type { IStorageProvider } from '../providers/storage/storage.interface';
import { importJobs } from '../schema/imports';
import { withTenant } from '../wrappers/with-tenant';

/** Minimal logger interface — both pino and the JobLogger from
 *  @emapp/jobs satisfy this shape. Defined inline so @emapp/db
 *  doesn't take a dep on @emapp/jobs. */
export interface PurgeLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface PurgeImportBytesOpts {
  readonly orgId: string;
  readonly jobId: string;
  /** The user-id to credit on audit rows. Worker path passes the
   *  verifiedActorId from verifyJobPayload; API cancel path passes
   *  the Manager who triggered the cancel. */
  readonly verifiedActorId: string;
  readonly storage: IStorageProvider;
  readonly log: PurgeLogger;
  /** v8.5 HIGH FIX (Audit Perf F4): hard deadline on the R2 delete.
   *  Without this, a stalled R2 connection holds the worker slot for
   *  the S3 client's socketTimeout (30 s default), starving pg-boss
   *  of concurrency during an R2 outage. The IStorageProvider contract
   *  doesn't expose AbortSignal yet (would be a v9 contract change),
   *  so we race the delete against a setTimeout and return 'purge-failed'
   *  on timeout — the same code path R2 errors already take, so a
   *  future sweeper retries. Default: 5 s — wide enough to absorb
   *  normal jitter (R2 P99 < 500 ms), narrow enough that a stuck pod
   *  recovers in seconds, not half a minute. */
  readonly deleteTimeoutMs?: number;
}

/** v8.5 internal: 5 s is the cross-confirmed sweet spot — see
 *  PurgeImportBytesOpts.deleteTimeoutMs. */
const DEFAULT_PURGE_DELETE_TIMEOUT_MS = 5_000;

/** Purge R2 bytes for a terminal import job. Idempotent and safe to
 *  call from multiple paths.
 *
 *  Returns:
 *    - `'purged'`     — bytes were just deleted; `file_deleted_at` set.
 *    - `'already'`    — the row was already purged.
 *    - `'not-terminal'` — the row exists but isn't in done/failed/cancelled.
 *    - `'missing'`    — the row isn't visible (RLS / vanished).
 *    - `'purge-failed'` — R2 delete itself failed (NEW in v8.5,
 *      separating from 'not-terminal' so future sweepers can
 *      distinguish "skip" from "retry-needed"). */
export async function purgeImportBytes(
  opts: PurgeImportBytesOpts,
): Promise<'purged' | 'already' | 'not-terminal' | 'missing' | 'purge-failed'> {
  const { orgId, jobId, verifiedActorId, storage, log } = opts;
  const deleteTimeoutMs = opts.deleteTimeoutMs ?? DEFAULT_PURGE_DELETE_TIMEOUT_MS;

  // Step 1: lookup + eligibility check.
  const row = await withTenant(
    orgId,
    async (tx) => {
      const [r] = await tx
        .select({
          fileR2Key: importJobs.fileR2Key,
          status: importJobs.status,
          fileDeletedAt: importJobs.fileDeletedAt,
        })
        .from(importJobs)
        .where(eq(importJobs.id, jobId))
        .limit(1);
      return r;
    },
    { userId: verifiedActorId },
  );
  if (!row) {
    log.warn('purgeImportBytes: row not visible — skip', { jobId });
    return 'missing';
  }
  if (row.fileDeletedAt !== null) return 'already';
  if (row.status !== 'done' && row.status !== 'failed' && row.status !== 'cancelled') {
    return 'not-terminal';
  }

  // Step 2: attempt the R2 delete. On failure, audit + return
  // 'purge-failed' so the caller can decide (current callers all
  // best-effort — they swallow the failure; future sweeper uses
  // this signal to schedule a retry).
  // v8.5: race the delete against a hard deadline so an R2 outage
  // can't pin the worker slot for the SDK's 30 s socketTimeout.
  // The S3 client's own delete keeps running in the background after
  // the deadline (no AbortSignal in IStorageProvider yet) — that's
  // OK: it's at most one orphaned socket per timeout, the Node
  // process recycles them via the global agent, and the outage by
  // definition means R2 will close them eventually. The important
  // thing is OUR control flow doesn't block.
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () =>
        reject(
          new Error(`purgeImportBytes: storage.delete exceeded ${deleteTimeoutMs}ms deadline`),
        ),
      deleteTimeoutMs,
    );
    // unref so the timer never keeps the event loop alive past the
    // race resolution (Node would otherwise wait the full timeout
    // for shutdown on the worker side).
    timeoutHandle.unref?.();
  });
  try {
    await Promise.race([storage.delete(row.fileR2Key), timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  } catch (e) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    log.error('purgeImportBytes: storage.delete failed — will retry on next purge cycle', {
      jobId,
      error: e instanceof Error ? e.message : 'unknown',
    });
    await withTenant(
      orgId,
      async (tx) => {
        await new AuditService(tx).log({
          orgId,
          // v8.5 SOLID #5: cleaner actor semantics — system-initiated
          // failure, no specific Manager to credit. actor_id is
          // omitted (the audit row's targetId already points at the
          // import_jobs row whose created_by is queryable).
          actorType: 'system',
          action: 'import.bytes_purge_failed',
          targetTable: 'import_jobs',
          targetId: jobId,
          metadata: {
            error_class: e instanceof Error ? e.name : 'unknown',
          },
        });
      },
      { userId: verifiedActorId },
    ).catch(() => undefined);
    return 'purge-failed';
  }

  // Step 3: success — set file_deleted_at + audit (guarded UPDATE
  // handles concurrent purge attempts).
  const updateResult = await withTenant(
    orgId,
    async (tx) => {
      const result = await tx
        .update(importJobs)
        .set({ fileDeletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(importJobs.id, jobId), isNull(importJobs.fileDeletedAt)));
      const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
      if (rowCount > 0) {
        await new AuditService(tx).log({
          orgId,
          actorType: 'system',
          action: 'import.bytes_purged',
          targetTable: 'import_jobs',
          targetId: jobId,
          metadata: {
            // v8.5 Sec HIGH-5: dropped the r2_key_prefix slice — it
            // leaked the org-id portion to the audit metadata. The
            // targetId already points at import_jobs.id which
            // identifies the row; the file path is implicit.
          },
        });
      }
      return rowCount;
    },
    { userId: verifiedActorId },
  );

  if (updateResult === 0) {
    // Concurrent purge won — treat as already-purged.
    return 'already';
  }
  log.info('import bytes purged', { jobId, status: row.status });
  return 'purged';
}
