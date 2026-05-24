import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { projects } from './projects';
import { organizations, users } from './tenancy';

/**
 * Phase 6 — Excel import pipeline.
 *
 * Architecture (locked):
 *  - Queue backend = pg-boss (docs/02 §354 + D.04: no Redis in MVP)
 *  - Worker = separate process (apps/worker/, Railway service)
 *
 * `import_jobs` is OUR domain state machine. pg-boss owns its own job
 * table in a separate schema; we correlate via `pgBossJobId`.
 *
 * Lifecycle:
 *   queued → parsing → validating → persisting → done | failed | cancelled
 *
 * Dry-run mode (T6.5): parse + validate but skip persistence.
 */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    /** State machine — enforced by CHECK in migration 0022. */
    status: text('status').notNull().default('queued'),

    /** Source file (uploaded via presigned PUT to R2). */
    fileR2Key: text('file_r2_key').notNull(),
    fileName: text('file_name').notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
    fileContentHash: text('file_content_hash').notNull(),

    /** Progress counters — NULL totalRows until parsing knows. */
    totalRows: integer('total_rows'),
    processedRows: integer('processed_rows').notNull().default(0),
    okRows: integer('ok_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),

    /** Aggregated error stats (per-row details in import_job_errors). */
    errorsSummary: jsonb('errors_summary').$type<Record<string, unknown>>(),

    /** T6.5 — dry-run skips persistence stage. */
    dryRun: boolean('dry_run').notNull().default(false),

    /** Future-mapping templates (S4). Nullable until then. */
    mappingTemplateId: uuid('mapping_template_id'),

    /** Phase 6 S6 — the project this import populates. Migration 0026
     *  adds the column nullable; the API layer (S8 wizard endpoint)
     *  enforces non-null on insert via the create-import Zod DTO. The
     *  worker's persistStage refuses to advance without it. Nullable
     *  here so the older tests + dev fixtures that don't set it can
     *  keep working through the validate stage. */
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'restrict',
    }),

    /** D.22 F idempotency. UNIQUE per (org, key) when non-null. */
    idempotencyKey: text('idempotency_key'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    /** pg-boss correlation (filled when worker picks up). */
    pgBossJobId: text('pg_boss_job_id'),

    /** v5 audit fix (P0 — D.34 wizard): parsed Excel headers from
     *  parseStage. Written when the worker transitions to
     *  `awaiting_mapping`; the S8 wizard endpoint reads them back to
     *  compute the real headers-fingerprint when storing a manual
     *  mapping_templates row (so the future L2 TemplateResolver can
     *  actually find these templates). Migration 0031. */
    parsedHeaders: jsonb('parsed_headers').$type<string[]>(),

    /** v8 §v8-S1 — R2 bytes purge timestamp. Set when the worker
     *  (or API cancel path) deletes the R2 object after a terminal
     *  state. Migration 0032's CHECK enforces "non-null only when
     *  status ∈ done/failed/cancelled." The sweeper + worker terminal
     *  check use `file_deleted_at IS NULL` as the eligibility guard. */
    fileDeletedAt: timestamp('file_deleted_at', { withTimezone: true }),
  },
  (table) => ({
    orgStatusCreatedIdx: index('idx_import_jobs_org_status_created').on(
      table.orgId,
      table.status,
      table.createdAt.desc(),
    ),
    idemUnique: uniqueIndex('import_jobs_idem_unique')
      .on(table.orgId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    workerPickupIdx: index('idx_import_jobs_worker_pickup')
      .on(table.createdAt)
      .where(sql`${table.status} IN ('queued','parsing','validating','persisting')`),
    statusCheck: check(
      'import_jobs_status_valid',
      sql`${table.status} IN ('queued','parsing','validating','persisting','done','failed','cancelled')`,
    ),
    sizeCheck: check(
      'import_jobs_size_reasonable',
      sql`${table.fileSizeBytes} > 0 AND ${table.fileSizeBytes} <= 52428800`,
    ),
  }),
);

export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;

/**
 * Per-row validation errors. CASCADE delete from import_jobs by design
 * (the only way to delete the parent is a provider-admin intervention).
 *
 * row_number is 1-indexed to match what the manager sees in their
 * spreadsheet — the source-of-truth pointer for "fix row X".
 *
 * D.12 + ISO A.9.4: NO `raw_row` column. The original (pre-audit) shape
 * stored the raw parsed row in jsonb — but urban-renewal Excel rows
 * contain national_id + phone (PII). Storing them unencrypted violated
 * the locked rule. Resolution: drop the column (migration 0023). The
 * manager fixes their source Excel using row_number + field + code,
 * then re-uploads. The original file is still in R2 via
 * `import_jobs.file_r2_key` — we don't duplicate row content.
 */
export const importJobErrors = pgTable(
  'import_job_errors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    rowNumber: integer('row_number').notNull(),
    field: text('field'),
    code: text('code').notNull(),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobRowIdx: index('idx_import_job_errors_job_row').on(table.jobId, table.rowNumber),
    // Audit-pass v2 C9 (MEDIUM, migration 0025): UNIQUE prevents
    // duplicate error rows on pg-boss retry. The handler's batched
    // INSERT uses ON CONFLICT (job_id, row_number, code) DO NOTHING.
    // Composite — a single row can fail multiple ways (invalid_luhn
    // AND invalid_phone) and produce two error entries with the same
    // row_number but different code; the composite preserves this
    // legitimate multiplicity while preventing exact duplicates.
    jobRowCodeUnique: uniqueIndex('import_job_errors_unique').on(
      table.jobId,
      table.rowNumber,
      table.code,
    ),
  }),
);

export type ImportJobError = typeof importJobErrors.$inferSelect;
export type NewImportJobError = typeof importJobErrors.$inferInsert;
