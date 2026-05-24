/**
 * Import bytes purger — v8 §v8-S1 closure.
 *
 * BACKGROUND
 *   Uploaded Excel files contain cleartext PII (national_id, phone,
 *   name, address). Pre-v8 they sat in R2 (`org/<id>/import/<uuid>.xlsx`)
 *   FOREVER — no delete on any terminal state, no R2 lifecycle rule.
 *   Israeli privacy-law right-to-erasure + ISO A.18.1.4 data-
 *   minimisation both failed. This module fixes that.
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
 *
 * AUDIT
 *   On success: `import.bytes_purged` with `{ r2_key }` metadata.
 *   On failure: `import.bytes_purge_failed` with `{ r2_key, error_class }`.
 *   Both inside the same withTenant tx as the UPDATE (or the audit-
 *   only write if no UPDATE happened).
 */
import { AuditService, importJobs, withTenant, type IStorageProvider } from '@emapp/db';
import type { JobLogger } from '@emapp/jobs';
import { and, eq, isNull, sql } from 'drizzle-orm';

export interface PurgeImportBytesOpts {
  readonly orgId: string;
  readonly jobId: string;
  readonly verifiedActorId: string;
  readonly storage: IStorageProvider;
  /** JobLogger-style: `log.warn(msg, meta?)`. The handler injects
   *  ctx.log directly; standalone callers can wrap a console with
   *  the same shape. */
  readonly log: JobLogger;
}

/** Purge R2 bytes for a terminal import job. Idempotent and safe to
 *  call from multiple paths (worker terminal-state check, API cancel
 *  follow-up, future scheduled sweeper).
 *
 *  Returns:
 *    - `'purged'`     — bytes were just deleted; `file_deleted_at` set.
 *    - `'already'`    — the row was already purged (file_deleted_at not null).
 *    - `'not-terminal'` — the row exists but isn't in done/failed/cancelled.
 *    - `'missing'`    — the row isn't visible (RLS / vanished). */
export async function purgeImportBytes(
  opts: PurgeImportBytesOpts,
): Promise<'purged' | 'already' | 'not-terminal' | 'missing'> {
  const { orgId, jobId, verifiedActorId, storage, log } = opts;

  // Step 1: lookup the R2 key and check eligibility. Done in its own
  // withTenant so a row that fails the precondition doesn't waste a
  // storage round-trip.
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

  // Step 2: attempt the R2 delete. On failure, audit + return; the
  // next purge call retries.
  try {
    await storage.delete(row.fileR2Key);
  } catch (e) {
    log.error('purgeImportBytes: storage.delete failed — will retry on next purge cycle', {
      jobId,
      error: e instanceof Error ? e.message : 'unknown',
    });
    await withTenant(
      orgId,
      async (tx) => {
        await new AuditService(tx).log({
          orgId,
          actorId: verifiedActorId,
          actorType: 'system',
          action: 'import.bytes_purge_failed',
          targetTable: 'import_jobs',
          targetId: jobId,
          metadata: {
            error_class: e instanceof Error ? e.name : 'unknown',
            r2_key_prefix: row.fileR2Key.slice(0, 32),
          },
        });
      },
      { userId: verifiedActorId },
    ).catch(() => undefined);
    return 'not-terminal'; // signal "not purged; will retry"
  }

  // Step 3: success — set file_deleted_at + audit. The UPDATE is
  // guarded against a concurrent purge (rowCount=0 means another
  // path already wrote file_deleted_at; we audit-skip in that case).
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
          actorId: verifiedActorId,
          actorType: 'system',
          action: 'import.bytes_purged',
          targetTable: 'import_jobs',
          targetId: jobId,
          metadata: {
            // Only the prefix (org-scoped) — never the full key which
            // contains the random UUID worth keeping uncorrelatable.
            r2_key_prefix: row.fileR2Key.slice(0, 32),
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

void sql; // imported for future raw-SQL extensions
// VerifiedJobIdentity is type-only; nothing else to do at runtime.
