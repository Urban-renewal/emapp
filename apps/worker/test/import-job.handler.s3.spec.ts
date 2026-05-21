/**
 * T6.1 (integration half) — ImportJobHandler with real parser + Fake
 * storage end-to-end. Complements the pure-unit parser tests in
 * excel.parser.spec.ts: there we verify the parser's contract; here we
 * verify the HANDLER wires it correctly (storage.getObjectStream →
 * parse → totalRows persisted → state transitions advance).
 *
 * Pinned invariants:
 *   1. handler with IStorageProvider parses + sets totalRows from real .xlsx
 *   2. parser ExcelParserError → NonRetryableJobError + import_jobs goes 'failed'
 *   3. storage I/O error (missing key) → propagates as retryable (NOT non-retryable)
 *   4. no IStorageProvider → falls back to S2 stub (totalRows = 0), keeps T6.8 baseline
 */
import { importJobs, FakeStorageProvider, withTenant } from '@emapp/db';
import { NonRetryableJobError, type ImportJobPayload, type JobContext } from '@emapp/jobs';
import { eq } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';

let org: TestOrg;

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

async function createJob(o: TestOrg, r2Key: string): Promise<string> {
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

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`T61-${Date.now()}`, `t61-${Date.now()}`);
});

afterAll(async () => {
  /* shared pool teardown by vitest workers */
});

describe('T6.1 (integration) — ImportJobHandler with real parser', () => {
  it('1) parses real .xlsx, sets totalRows, reaches done', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/t61-1.xlsx`;
    storage.setObject(
      r2Key,
      // S4 wires mapping resolution into parseStage; the fixture now
      // includes the full required canonical set (national_id, phone,
      // name, apartment, address) so mapping passes alongside parsing.
      await buildXlsxBuffer([
        ['national_id', 'phone', 'name', 'apartment', 'address'],
        ['123456782', '0501234567', 'Avi', '1', 'Herzl 10'],
        ['234567894', '0512345678', 'Bob', '2', 'Herzl 10'],
        ['345678905', '0523456789', 'Carol', '3', 'Herzl 10'],
      ]),
    );
    const jobId = await createJob(org, r2Key);
    const payload: ImportJobPayload = {
      jobId,
      orgId: org.id,
      createdBy: org.users[0]!.id,
    };

    await handler.handle(payload, makeCtx());

    const row = await getJob(org, jobId);
    expect(row?.status).toBe('done');
    expect(row?.totalRows).toBe(3);
  });

  it('2) parser error → NonRetryableJobError + state = failed', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/t61-2.xlsx`;
    // Sparse header (1 cell) — parser rejects with sparse_header.
    storage.setObject(r2Key, await buildXlsxBuffer([['only-one']]));
    const jobId = await createJob(org, r2Key);

    await expect(
      handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx()),
    ).rejects.toMatchObject({
      name: 'NonRetryableJobError',
      code: 'parse_sparse_header',
    });

    const row = await getJob(org, jobId);
    expect(row?.status).toBe('failed');
  });

  it('3) missing key (R2 404 analogue) → propagates as retryable', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/missing.xlsx`;
    // NOT seeded — storage.getObjectStream will throw.
    const jobId = await createJob(org, r2Key);

    let caught: unknown;
    try {
      await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    } catch (e) {
      caught = e;
    }
    // Crucially NOT NonRetryableJobError — a transient storage blip
    // warrants pg-boss retry. (markFailed still ran inside the handler
    // catch, so the row IS 'failed' — but the thrown error type is the
    // raw Error from the storage, which the adapter forwards as
    // retryable.)
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(NonRetryableJobError);
  });

  it('4) no IStorageProvider → S2 stub fallback (totalRows = 0)', async () => {
    const handler = new ImportJobHandler(); // no storage
    const jobId = await createJob(org, `org/${org.id}/import/noop.xlsx`);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const row = await getJob(org, jobId);
    expect(row?.status).toBe('done');
    expect(row?.totalRows).toBe(0); // S2 stub semantics — keeps T6.8 baseline
  });
});
