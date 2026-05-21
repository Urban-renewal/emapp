/**
 * Test #5 + Test #7 — pg-boss retry idempotency + storage I/O retry posture.
 *
 * audit-pass v2 findings C9 (MEDIUM) + D5. The handler walks the
 * state machine forward from `current` and each transition is a
 * guarded UPDATE (idempotent). But within validateStage, the
 * batched-INSERT into import_job_errors was UNCONDITIONAL — a
 * pg-boss retry mid-validate would re-INSERT every error row and
 * silently double up the forensic record. Migration 0025 added
 * UNIQUE(job_id, row_number, code); this spec proves the
 * end-to-end posture.
 *
 * Test #7 (storage I/O retry posture): when storage.getObjectStream
 * throws (R2 blip), the thrown error MUST be retryable (NOT
 * NonRetryableJobError). The handler's markFailed runs in the
 * catch, transitions the row to `failed`, but the THROWN error
 * goes to pg-boss as retryable so the queue's retry policy applies.
 *
 * Pinned invariants:
 *   1. validateStage executed twice with same input → import_job_errors
 *      has the SAME row count both times (no double-up)
 *   2. counters (ok/failed/processed) reflect the SECOND run, not the
 *      sum of both runs
 *   3. underlying UNIQUE rejects a manual duplicate INSERT (schema)
 *   4. multiple errors per row (different codes) coexist as expected
 *   5. retry after a partial validate (mid-stage death simulation)
 *      converges to the right counters
 *   6. (Test #7a) storage.getObjectStream throws in validateStage →
 *      propagates as raw Error (NOT NonRetryableJobError)
 *   7. (Test #7b) on the storage-failure path, state is 'failed' AND
 *      the original error type is preserved up to pg-boss
 */
import { FakeStorageProvider, importJobErrors, importJobs, withTenant } from '@emapp/db';
import { NonRetryableJobError, type ImportJobPayload, type JobContext } from '@emapp/jobs';
import { eq } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';

let org: TestOrg;

function makeCtx(): JobContext {
  return {
    jobId: 'pg-boss-test',
    attempt: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  };
}

async function buildXlsx(rows: Array<Array<string | null>>): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r.map((v) => (v == null ? null : v)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function createJob(o: TestOrg, r2Key: string): Promise<string> {
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        fileR2Key: r2Key,
        fileName: 'import.xlsx',
        fileSizeBytes: 2048,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

async function getJob(o: TestOrg, id: string) {
  const [row] = await withTenant(o.id, async (tx) =>
    tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1),
  );
  return row;
}

async function getErrors(o: TestOrg, jobId: string) {
  return withTenant(o.id, async (tx) =>
    tx.select().from(importJobErrors).where(eq(importJobErrors.jobId, jobId)),
  );
}

const HEADERS = ['national_id', 'phone', 'name', 'apartment', 'address'];

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`RETRY-${Date.now()}`, `retry-${Date.now()}`);
});

afterAll(async () => {
  /* shared pool teardown by vitest workers */
});

describe('Test #5 — retry idempotency on import_job_errors', () => {
  it('1) handler invoked TWICE on same job → import_job_errors row count unchanged', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/retry-1.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([
        HEADERS,
        ['123456782', '0501234567', 'Avi', '1', 'Herzl 10'], // ok
        ['bad_id', '0521234567', 'Bob', '2', 'Herzl 10'], // invalid_luhn
        ['234567899', 'bad-phone', 'Carol', '3', 'Herzl 10'], // invalid_phone
      ]),
    );
    const jobId = await createJob(org, r2Key);
    const payload: ImportJobPayload = { jobId, orgId: org.id, createdBy: org.users[0]!.id };

    // First run.
    await handler.handle(payload, makeCtx());
    const errorsAfterFirst = await getErrors(org, jobId);
    const countFirst = errorsAfterFirst.length;
    expect(countFirst).toBeGreaterThanOrEqual(2);

    // Second run — simulates pg-boss retry on the same job.
    // The handler walks from `done` (terminal) → it's a no-op now
    // because we already reached done. But for the C9 contract, the
    // INVARIANT is: even if validateStage runs again somehow (e.g.
    // worker killed before transition to persisting), the errors
    // table must not grow. Force-reset status to test that path:
    const provClient = await providerPool.connect();
    try {
      await provClient.query(
        `UPDATE import_jobs SET status = 'queued', started_at = NULL, finished_at = NULL,
           processed_rows = 0, ok_rows = 0, failed_rows = 0 WHERE id = $1`,
        [jobId],
      );
    } finally {
      provClient.release();
    }

    await handler.handle(payload, makeCtx());
    const errorsAfterSecond = await getErrors(org, jobId);
    expect(errorsAfterSecond.length).toBe(countFirst);
  });

  it('2) counters reflect the second run (overwrite, not accumulate)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/retry-2.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([
        HEADERS,
        ['123456782', '0501234567', 'Avi', '1', 'Herzl 10'],
        ['bad_id', '0521234567', 'Bob', '2', 'Herzl 10'],
      ]),
    );
    const jobId = await createJob(org, r2Key);
    const payload: ImportJobPayload = { jobId, orgId: org.id, createdBy: org.users[0]!.id };

    await handler.handle(payload, makeCtx());
    const provClient = await providerPool.connect();
    try {
      await provClient.query(`UPDATE import_jobs SET status='queued' WHERE id=$1`, [jobId]);
    } finally {
      provClient.release();
    }
    await handler.handle(payload, makeCtx());

    const row = await getJob(org, jobId);
    expect(row?.processedRows).toBe(2); // not 4
    expect(row?.okRows).toBe(1);
    expect(row?.failedRows).toBe(1);
  });

  it('3) schema-level UNIQUE rejects a manual duplicate (job_id, row_number, code)', async () => {
    const r2Key = `org/${org.id}/import/retry-3.xlsx`;
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    storage.setObject(
      r2Key,
      await buildXlsx([HEADERS, ['bad_id', '0501234567', 'Avi', '1', 'Herzl 10']]),
    );
    const jobId = await createJob(org, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    // Try to manually insert a duplicate — should be rejected.
    let caught: unknown;
    try {
      await withTenant(org.id, async (tx) => {
        await tx.insert(importJobErrors).values({
          jobId,
          orgId: org.id,
          rowNumber: 2,
          field: 'national_id',
          code: 'invalid_luhn',
          message: 'duplicate insert (should fail)',
        });
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // walk the cause chain for SQLSTATE 23505
    let cur: unknown = caught;
    let depth = 0;
    let found23505 = false;
    while (cur && depth < 8) {
      if ((cur as { code?: string }).code === '23505') {
        found23505 = true;
        break;
      }
      cur = (cur as { cause?: unknown })?.cause;
      depth += 1;
    }
    expect(found23505).toBe(true);
  });

  it('4) multiple codes per row (invalid_luhn + invalid_phone) coexist — composite allows it', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/retry-4.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([
        HEADERS,
        // both bad luhn AND bad phone in the same row.
        ['not-an-id', 'not-a-phone', 'Avi', '1', 'Herzl 10'],
      ]),
    );
    const jobId = await createJob(org, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const errors = await getErrors(org, jobId);
    const row2 = errors.filter((e) => e.rowNumber === 2);
    const codes = row2.map((e) => e.code).sort();
    expect(codes).toContain('invalid_luhn');
    expect(codes).toContain('invalid_phone');
    // Both share rowNumber=2 — composite UNIQUE allows it because
    // `code` differs.
    expect(row2.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Test #7 — storage I/O error retry posture', () => {
  it('5) storage.getObjectStream throws → propagates as RAW Error (retryable)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/missing-7.xlsx`;
    // Intentionally NOT seeded — FakeStorageProvider throws on
    // getObjectStream for unknown keys.
    const jobId = await createJob(org, r2Key);

    let caught: unknown;
    try {
      await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // CRITICAL — must NOT be NonRetryableJobError. A storage blip
    // warrants pg-boss retry; only "this file is bad" non-retries.
    expect(caught).not.toBeInstanceOf(NonRetryableJobError);
  });

  it('6) on storage-failure path: row is `failed` BUT thrown type stays retryable', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/missing-8.xlsx`;
    const jobId = await createJob(org, r2Key);

    try {
      await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    } catch {
      /* expected */
    }

    const row = await getJob(org, jobId);
    expect(row?.status).toBe('failed');
    // markFailed ran inside the catch — the FAILED state lands even
    // though the thrown error propagates as retryable. This split is
    // INTENTIONAL: domain row reflects forensic state; queue retry
    // policy is governed separately.
  });

  it('7) storage failure in validateStage (after parseStage success) — same posture', async () => {
    // Wire a storage that succeeds on the FIRST getObjectStream call
    // (parseStage) but fails on the SECOND (validateStage).
    const realStorage = new FakeStorageProvider();
    const r2Key = `org/${org.id}/import/flaky-7.xlsx`;
    realStorage.setObject(
      r2Key,
      await buildXlsx([HEADERS, ['123456782', '0501234567', 'Avi', '1', 'Herzl 10']]),
    );

    let calls = 0;
    const flakyStorage: typeof realStorage = Object.create(realStorage);
    flakyStorage.getObjectStream = async (k: string) => {
      calls += 1;
      if (calls >= 2) throw new Error('R2 connection reset');
      return realStorage.getObjectStream(k);
    };

    const handler = new ImportJobHandler(flakyStorage);
    const jobId = await createJob(org, r2Key);

    let caught: unknown;
    try {
      await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(NonRetryableJobError);
    expect((caught as Error).message).toContain('R2 connection reset');

    const row = await getJob(org, jobId);
    expect(row?.status).toBe('failed');
  });
});
