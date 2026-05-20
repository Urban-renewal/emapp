/**
 * The `import.excel` job — Phase 6 Excel pipeline.
 *
 * Enqueued by `apps/api/` after the manager POSTs to /imports with a
 * file_r2_key. Consumed by `apps/worker/` which loads the file from
 * R2, streams it through ExcelJS, validates, and persists.
 *
 * Payload is INTENTIONALLY MINIMAL — just enough for the worker to
 * load the domain row from the DB. NO PII in the payload (the file
 * itself is in R2 with the manager's encrypted credentials; the
 * payload only carries the reference). This keeps the pg-boss `job`
 * table free of PII, so its retention/inspection by ops is safe.
 */
import { z } from 'zod';

/** Job name registered with pg-boss. Namespaced to allow future
 *  job types (export.excel, notifications.send, etc.) to share the
 *  same queue infrastructure without collision. */
export const IMPORT_JOB_NAME = 'import.excel' as const;

/** Validated payload — Zod-parsed by the worker before the handler
 *  is even called, so the handler sees only well-formed input.
 *  STRICT — extra fields are rejected (defense against payload
 *  confusion if pg-boss is ever shared with another producer). */
export const ImportJobPayloadSchema = z
  .object({
    /** `import_jobs.id` (UUID) — the worker loads this row to get
     *  file_r2_key, dry_run, and the rest of the parameters. */
    jobId: z.string().uuid(),

    /** `import_jobs.org_id` — used to scope withTenant during the
     *  domain writes. Carried in the payload (not just loaded from
     *  the row) so the worker can establish withTenant context BEFORE
     *  the first DB read — otherwise the row would be invisible to
     *  RLS. This is the standard pg-boss pattern. */
    orgId: z.string().uuid(),

    /** `import_jobs.created_by` (UUID) — used for audit_log writes
     *  during the import flow (T6.8 + A.12.4 ISO). */
    createdBy: z.string().uuid(),
  })
  .strict();

export type ImportJobPayload = z.infer<typeof ImportJobPayloadSchema>;
