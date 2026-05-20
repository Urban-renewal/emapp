-- 0022: import_jobs + import_job_errors — Phase 6 Excel import pipeline
--
-- Spec: docs/03 §10. State machine:
--   queued → parsing → validating → persisting → done | failed | cancelled
--
-- Architectural locks (docs/02 §354 + D.04):
--   - Queue backend = pg-boss (Postgres-backed; no Redis in MVP)
--   - Worker = separate process (apps/worker/ Railway service)
--   - The pg-boss `job` table is owned by pg-boss in its own schema;
--     this `import_jobs` table is OUR domain state machine that pg-boss
--     drives. We track `pg_boss_job_id` for forensic correlation.
--
-- RLS: org-direct, same pattern as documents/signatures/signature_requests.
-- The worker process runs queries through withProvider (BYPASSRLS, for
-- queue plumbing) AND withTenant (for the actual data writes — RLS
-- still applies on owners/apartments/buildings inserts).
--
-- Idempotency: optional `idempotency_key` (D.22 F) — when supplied,
-- UNIQUE per (org, key) so a network-retry of "POST /imports" hits the
-- existing job row instead of creating a duplicate.
--
-- All steps idempotent (guards) so concurrent test-worker migrate() is safe.

-- ════════════════════ import_jobs ════════════════════════════════════

CREATE TABLE IF NOT EXISTS import_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- State machine.
  status              text NOT NULL DEFAULT 'queued',

  -- Source file (uploaded via presigned PUT to R2, same flow as docs).
  file_r2_key         text NOT NULL,
  file_name           text NOT NULL,
  file_size_bytes     bigint NOT NULL,
  file_content_hash   text NOT NULL,

  -- Progress counters. NULL `total_rows` until the parsing stage knows
  -- the row count; processed/ok/failed update during validating +
  -- persisting and drive the SSE stream.
  total_rows          integer,
  processed_rows      integer NOT NULL DEFAULT 0,
  ok_rows             integer NOT NULL DEFAULT 0,
  failed_rows         integer NOT NULL DEFAULT 0,

  -- Aggregated error stats — bounded surface for the manager UI.
  -- Per-row details live in import_job_errors.
  errors_summary      jsonb,

  -- Options. dry_run = parse + validate but skip persistence
  -- (docs/03 §10 T6.5 — "Dry-run no DB change").
  dry_run             boolean NOT NULL DEFAULT false,

  -- Optional saved-mapping reference (added in a future migration when
  -- mapping templates land — S4). Kept nullable so this migration is
  -- self-sufficient.
  mapping_template_id uuid,

  -- D.22 F — Idempotency-Key (optional). UNIQUE per org when present
  -- so a network retry of "create import" returns the same job.
  idempotency_key     text,

  -- Audit + forensics.
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,

  -- pg-boss correlation. Filled when the worker picks up the job.
  pg_boss_job_id      text
);

-- status CHECK — fail-closed enum (matches D.18 pattern: text + CHECK).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'import_jobs_status_valid'
      AND conrelid = 'import_jobs'::regclass
  ) THEN
    ALTER TABLE import_jobs
      ADD CONSTRAINT import_jobs_status_valid
      CHECK (status IN (
        'queued', 'parsing', 'validating', 'persisting',
        'done', 'failed', 'cancelled'
      ));
  END IF;
END;
$$;

-- File size CHECK — defense-in-depth against a bad client. 50MB cap
-- matches docs/03 §10 + the documents-module ceiling.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'import_jobs_size_reasonable'
      AND conrelid = 'import_jobs'::regclass
  ) THEN
    ALTER TABLE import_jobs
      ADD CONSTRAINT import_jobs_size_reasonable
      CHECK (file_size_bytes > 0 AND file_size_bytes <= 52428800);
  END IF;
END;
$$;

-- ════════════════════ indexes ════════════════════════════════════════

-- Manager list: org + status + recency.
CREATE INDEX IF NOT EXISTS idx_import_jobs_org_status_created
  ON import_jobs (org_id, status, created_at DESC);

-- Idempotency lookup. PARTIAL UNIQUE — only when key is non-null.
CREATE UNIQUE INDEX IF NOT EXISTS import_jobs_idem_unique
  ON import_jobs (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Worker poll: jobs the worker should pick up (queued → parsing/etc).
-- Partial so it stays small even as `done`/`failed` rows accumulate.
CREATE INDEX IF NOT EXISTS idx_import_jobs_worker_pickup
  ON import_jobs (created_at)
  WHERE status IN ('queued', 'parsing', 'validating', 'persisting');

-- ════════════════════ RLS ════════════════════════════════════════════

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'import_jobs'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON import_jobs
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- ════════════════════ grants ═════════════════════════════════════════
-- Explicit GRANT (belt-and-suspenders over default privileges from
-- migration 0009). The worker process uses the same app_user role
-- inside withTenant when writing org-scoped progress; pg-boss plumbing
-- itself uses the BYPASSRLS provider pool.

GRANT SELECT, INSERT, UPDATE ON import_jobs TO app_user;
-- No DELETE: an import job is forensic evidence — cancellation is a
-- status transition, not a row delete.

-- ════════════════════ import_job_errors ══════════════════════════════
-- Per-row validation errors. Cascade-delete on job-delete is intentional
-- (the only way to delete the parent job is a manual provider-admin
-- intervention — never via the app surface).

CREATE TABLE IF NOT EXISTS import_job_errors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- 1-indexed row number in the Excel file (matching what the manager
  -- sees in their spreadsheet — the source-of-truth pointer).
  row_number   integer NOT NULL,
  field        text,
  code         text NOT NULL,
  message      text,
  -- Raw row as parsed. Bounded: clients can produce wide rows, we
  -- accept up to ~8KB per row (jsonb compresses well). Stored so the
  -- manager can resubmit a fixed Excel without re-uploading the whole
  -- file.
  raw_row      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- index for the errors-export endpoint (S8): job → list ordered by row.
CREATE INDEX IF NOT EXISTS idx_import_job_errors_job_row
  ON import_job_errors (job_id, row_number);

-- ════════════════════ RLS on errors ══════════════════════════════════

ALTER TABLE import_job_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_errors FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'import_job_errors'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON import_job_errors
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

GRANT SELECT, INSERT ON import_job_errors TO app_user;
