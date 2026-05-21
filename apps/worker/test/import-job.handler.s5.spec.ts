/**
 * T6.3/T6.4/T6.5 integration — ImportJobHandler validateStage +
 * persistStage end-to-end with real DB.
 *
 * Pinned invariants:
 *   1. valid file → all rows ok, no import_job_errors, totals correct
 *   2. mixed file (good + bad rows) → ok_rows + failed_rows match;
 *      import_job_errors carries one row per error, row_number 1-indexed
 *   3. T6.4 — in-file duplicate national_id → duplicate_national_id
 *      error on the second occurrence; first occurrence is OK
 *   4. T6.5 — dry_run=true → handler reaches `done` AND validateStage
 *      ran (failed_rows counts mismatches); persistStage is a documented
 *      no-op for now (real persistence ships in S6)
 *   5. errors rows respect RLS — Org B sees zero rows for Org A's job
 *   6. error messages don't carry PII (defense in depth — also
 *      asserted at the unit level in row-validator.spec.ts)
 */
import { FakeStorageProvider, importJobErrors, importJobs, withTenant } from '@emapp/db';
import { type ImportJobPayload, type JobContext } from '@emapp/jobs';
import { eq } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';

let org: TestOrg;
let orgB: TestOrg;

function makeCtx(over: Partial<JobContext> = {}): JobContext {
  return {
    jobId: 'pg-boss-test',
    attempt: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
    ...over,
  };
}

async function buildXlsxBuffer(rows: Array<Array<string | number | null>>): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r.map((v) => (v == null ? null : v)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function createJob(
  o: TestOrg,
  r2Key: string,
  opts: { dryRun?: boolean } = {},
): Promise<string> {
  // projectId required as of audit-pass v3 D5.
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        projectId: o.projects[0]!.id,
        fileR2Key: r2Key,
        fileName: 'import.xlsx',
        fileSizeBytes: 1024,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
        dryRun: opts.dryRun ?? false,
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

const VALID_HEADERS = ['national_id', 'phone', 'name', 'apartment', 'address'];
// Known-Luhn-valid Israeli IDs.
const GOOD_ID_1 = '123456782';
// Luhn check-digit verified by hand: pad-to-9 + alternating-double sum
// divisible by 10. (The earlier values 234567894 / 345678905 had bad
// check digits — caught by S5 integration test.)
const GOOD_ID_2 = '234567899';
const GOOD_ID_3 = '345678908';

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  org = await createTestOrg(`T6V-${ts}`, `t6v-${ts}`);
  orgB = await createTestOrg(`T6V-B-${ts}`, `t6v-b-${ts}`);
});

afterAll(async () => {
  /* shared pool teardown by vitest workers */
});

describe('T6.3/T6.4/T6.5 — ImportJobHandler validate + dry-run', () => {
  it('1) valid file → all rows ok, no import_job_errors', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/v1.xlsx`;
    storage.setObject(
      key,
      await buildXlsxBuffer([
        VALID_HEADERS,
        [GOOD_ID_1, '0501234567', 'Avi', '1', 'Herzl 10'],
        [GOOD_ID_2, '0521234567', 'Bob', '2', 'Herzl 10'],
        [GOOD_ID_3, '0531234567', 'Carol', '3', 'Herzl 10'],
      ]),
    );
    const jobId = await createJob(org, key);
    const payload: ImportJobPayload = { jobId, orgId: org.id, createdBy: org.users[0]!.id };

    await handler.handle(payload, makeCtx());

    const row = await getJob(org, jobId);
    expect(row?.status).toBe('done');
    expect(row?.totalRows).toBe(3);
    expect(row?.processedRows).toBe(3);
    expect(row?.okRows).toBe(3);
    expect(row?.failedRows).toBe(0);

    const errors = await getErrors(org, jobId);
    expect(errors).toEqual([]);
  });

  it('2) mixed file → counters + import_job_errors track each error', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/v2.xlsx`;
    storage.setObject(
      key,
      await buildXlsxBuffer([
        VALID_HEADERS,
        [GOOD_ID_1, '0501234567', 'Avi', '1', 'Herzl 10'], // ok
        ['bad_id', '0521234567', 'Bob', '2', 'Herzl 10'], // invalid_luhn
        [GOOD_ID_2, '12345', 'Carol', '3', 'Herzl 10'], // invalid_phone
      ]),
    );
    const jobId = await createJob(org, key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const row = await getJob(org, jobId);
    expect(row?.status).toBe('done');
    expect(row?.processedRows).toBe(3);
    expect(row?.okRows).toBe(1);
    expect(row?.failedRows).toBe(2);

    const errors = await getErrors(org, jobId);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain('invalid_luhn');
    expect(codes).toContain('invalid_phone');

    // Row numbers are 1-indexed Excel rows. Header is row 1; first
    // data row is 2; bad_id is on row 3; invalid_phone on row 4.
    const luhnErr = errors.find((e) => e.code === 'invalid_luhn')!;
    expect(luhnErr.rowNumber).toBe(3);
    const phoneErr = errors.find((e) => e.code === 'invalid_phone')!;
    expect(phoneErr.rowNumber).toBe(4);
  });

  it('3) T6.4 in-file duplicate national_id → duplicate_national_id on the second row', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/v3.xlsx`;
    storage.setObject(
      key,
      await buildXlsxBuffer([
        VALID_HEADERS,
        [GOOD_ID_1, '0501234567', 'Avi', '1', 'Herzl 10'],
        [GOOD_ID_1, '0521234567', 'Bob', '2', 'Herzl 10'], // dup
      ]),
    );
    const jobId = await createJob(org, key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const row = await getJob(org, jobId);
    expect(row?.okRows).toBe(1);
    expect(row?.failedRows).toBe(1);

    const errors = await getErrors(org, jobId);
    const dup = errors.find((e) => e.code === 'duplicate_national_id');
    expect(dup).toBeDefined();
    expect(dup!.rowNumber).toBe(3);
  });

  it('4) T6.5 dry_run=true → handler reaches done; validateStage ran; persistStage no-op', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/v4.xlsx`;
    storage.setObject(
      key,
      await buildXlsxBuffer([
        VALID_HEADERS,
        [GOOD_ID_1, '0501234567', 'Avi', '1', 'Herzl 10'],
        ['bad_id', '0521234567', 'Bob', '2', 'Herzl 10'],
      ]),
    );
    const jobId = await createJob(org, key, { dryRun: true });

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const row = await getJob(org, jobId);
    expect(row?.status).toBe('done');
    expect(row?.dryRun).toBe(true);
    // Validation still ran in dry-run — manager sees what WOULD happen.
    expect(row?.processedRows).toBe(2);
    expect(row?.okRows).toBe(1);
    expect(row?.failedRows).toBe(1);

    // Errors are still recorded (the manager needs to see them).
    const errors = await getErrors(org, jobId);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('5) RLS — Org B sees zero import_job_errors for an Org A job', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/v5.xlsx`;
    storage.setObject(
      key,
      await buildXlsxBuffer([VALID_HEADERS, ['bad_id', '0521234567', 'Bob', '2', 'Herzl 10']]),
    );
    const jobId = await createJob(org, key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const orgBErrors = await withTenant(orgB.id, (tx) =>
      tx.select().from(importJobErrors).where(eq(importJobErrors.jobId, jobId)),
    );
    expect(orgBErrors).toEqual([]);
  });

  it('6) error messages carry NO PII (no raw national_id / phone in any row)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/v6.xlsx`;
    storage.setObject(
      key,
      await buildXlsxBuffer([VALID_HEADERS, ['999888777', '12345', 'OkName', '1', 'Herzl 10']]),
    );
    const jobId = await createJob(org, key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const errors = await getErrors(org, jobId);
    for (const e of errors) {
      expect(e.message ?? '').not.toContain('999888777');
      expect(e.message ?? '').not.toContain('12345');
    }
  });
});
