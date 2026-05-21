/**
 * Test #6 — Cross-import dedup decision (audit-pass v2 Track 2).
 *
 * Audit-pass v2 read the docs/03 §10 T6.4 spec ("Dedup detection —
 * אותו ID פעמיים") and flagged that it could be read as cross-import
 * — the same national_id appearing in TWO separate uploads. Our S5
 * validation only catches IN-FILE duplicates. The audit asked: is
 * cross-import dedup also in scope?
 *
 * Decision (recorded by this spec):
 *   IN-FILE dedup is at the VALIDATION stage (S5).
 *   CROSS-IMPORT dedup is at the PERSISTENCE stage (S6 — find-or-
 *   create on `owners.national_id_hash`). This is the right layer
 *   architecturally:
 *     - The owners table has UNIQUE (org_id, national_id_hash) WHERE
 *       archived_at IS NULL (see packages/db/src/schema/projects.ts
 *       line 137). A second import producing the same hash IS
 *       allowed at validate time but RESOLVES at persist time —
 *       the existing owner is reused, the new apartment gets an
 *       additional ownership row. THAT is the right product
 *       behavior: when the same owner appears in two imports for
 *       different apartments, both apartments share that owner.
 *     - Forcing a cross-import reject at validate time would FAIL
 *       a perfectly legitimate import (e.g. a husband+wife couple
 *       owning 5 apartments across 5 separate import files).
 *
 * This spec PINS the current behavior so future product changes
 * are explicit: it asserts that a second import containing the same
 * national_id as a prior import PASSES validation (failedRows=0).
 *
 * The persistence-time cross-import resolution will be tested in
 * the S6 persistence spec (when S6 lands).
 */
import { FakeStorageProvider, importJobErrors, importJobs, withTenant } from '@emapp/db';
import { type JobContext } from '@emapp/jobs';
import { eq } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';

let org: TestOrg;

function makeCtx(): JobContext {
  return {
    jobId: 'pg-boss-tid',
    attempt: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  };
}

const HEADERS = ['national_id', 'phone', 'name', 'apartment', 'address'];

async function buildXlsx(rows: Array<Array<string>>): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(r);
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

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`CRD-${Date.now()}`, `crd-${Date.now()}`);
});

afterAll(async () => {
  /* pool teardown by vitest workers */
});

describe('Test #6 — cross-import dedup (deliberately at persistence, NOT validation)', () => {
  it('1) same national_id across two separate imports → BOTH pass validation', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const sharedId = '123456782'; // Luhn-valid

    // Import #1 — a single row with sharedId.
    const key1 = `org/${org.id}/import/crd-1a.xlsx`;
    storage.setObject(key1, await buildXlsx([[sharedId, '0501234567', 'Avi', '1', 'Herzl 10']]));
    const jobId1 = await createJob(org, key1);
    await handler.handle({ jobId: jobId1, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const [job1] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId1)).limit(1),
    );
    expect(job1?.okRows).toBe(1);
    expect(job1?.failedRows).toBe(0);

    // Import #2 — SAME national_id, different apartment. Validation
    // MUST NOT flag this as a duplicate (cross-import dedup is a
    // persistence-stage concern).
    const key2 = `org/${org.id}/import/crd-1b.xlsx`;
    storage.setObject(
      key2,
      await buildXlsx([[sharedId, '0521234567', 'Avi (2nd apartment)', '5', 'Herzl 10']]),
    );
    const jobId2 = await createJob(org, key2);
    await handler.handle({ jobId: jobId2, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const [job2] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId2)).limit(1),
    );
    expect(job2?.okRows).toBe(1);
    expect(job2?.failedRows).toBe(0);

    // No error rows in import_job_errors for either job.
    const errors1 = await withTenant(org.id, (tx) =>
      tx.select().from(importJobErrors).where(eq(importJobErrors.jobId, jobId1)),
    );
    const errors2 = await withTenant(org.id, (tx) =>
      tx.select().from(importJobErrors).where(eq(importJobErrors.jobId, jobId2)),
    );
    expect(errors1).toEqual([]);
    expect(errors2).toEqual([]);
  }, 60_000);

  it('2) IN-FILE dedup still fires (T6.4 not broken by the cross-import allowance)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const id = '234567899';
    const key = `org/${org.id}/import/crd-2.xlsx`;
    storage.setObject(
      key,
      await buildXlsx([
        [id, '0501234567', 'Avi', '1', 'Herzl 10'],
        [id, '0521234567', 'Bob', '2', 'Herzl 10'], // in-file dup
      ]),
    );
    const jobId = await createJob(org, key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const [job] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1),
    );
    expect(job?.okRows).toBe(1);
    expect(job?.failedRows).toBe(1);

    const errors = await withTenant(org.id, (tx) =>
      tx.select().from(importJobErrors).where(eq(importJobErrors.jobId, jobId)),
    );
    expect(errors.some((e) => e.code === 'duplicate_national_id')).toBe(true);
  }, 60_000);
});
