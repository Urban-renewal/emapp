/**
 * D.34 — handler transitions to 'awaiting_mapping' on Layer-1 miss.
 *
 * Closes the customer-onboarding problem the user raised: not every
 * Excel file uses our canonical aliases. Pre-S7 the handler threw
 * NonRetryableJobError and the row went to 'failed' — the manager
 * saw "your file is wrong" with no recovery path. Post-S7 the row
 * lands in 'awaiting_mapping' and the wizard / agent picks it up.
 *
 * Pinned invariants:
 *   1. headers with no Layer-1 alias match → status = 'awaiting_mapping'
 *      (NOT 'failed', NOT NonRetryable)
 *   2. an 'import.awaiting_mapping' audit row is written with the
 *      resolver name + header count (metadata structured, no PII)
 *   3. totalRows is set (parseStage's row count) so the manager has
 *      a sense of file size before they map
 *   4. the handler returns cleanly (no throw, pg-boss happy)
 *   5. duplicate alias in the file (reject) → state=failed (NOT
 *      awaiting_mapping) — fail loud for malformed input
 */
import { FakeStorageProvider, importJobs, auditLog, withTenant } from '@emapp/db';
import { type JobContext } from '@emapp/jobs';
import { and, eq } from 'drizzle-orm';
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

async function buildXlsx(headers: string[], rows: string[][]): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function createJob(o: TestOrg, r2Key: string): Promise<string> {
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        projectId: o.projects[0]!.id,
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
  org = await createTestOrg(`AM-${Date.now()}`, `am-${Date.now()}`);
});

afterAll(async () => {
  /* pool teardown */
});

describe('D.34 — awaiting_mapping transition on Layer-1 miss', () => {
  it('1) unknown headers → status=awaiting_mapping (NOT failed)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/am-1.xlsx`;
    // Use headers that don't match any Layer-1 alias.
    storage.setObject(
      r2Key,
      await buildXlsx(
        ['client_identifier', 'cellular', 'contact_label', 'unit_ref', 'street_locator'],
        [['123', '050', 'Avi', '1', 'Herzl 10']],
      ),
    );
    const jobId = await createJob(org, r2Key);

    // Should NOT throw.
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const [row] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1),
    );
    expect(row?.status).toBe('awaiting_mapping');
    // Parser ran successfully — totalRows is set.
    expect(row?.totalRows).toBe(1);
    // No persistence happened — okRows stays 0.
    expect(row?.okRows).toBe(0);
  }, 60_000);

  it('2) awaiting_mapping audit row written with resolver name', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/am-2.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx(
        ['mystery_1', 'mystery_2', 'mystery_3', 'mystery_4', 'mystery_5'],
        [['a', 'b', 'c', 'd', 'e']],
      ),
    );
    const jobId = await createJob(org, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const rows = await withTenant(org.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
    );
    const awaiting = rows.find((r) => r.action === 'import.awaiting_mapping');
    expect(awaiting).toBeDefined();
    expect(awaiting!.actorType).toBe('system');
    expect(awaiting!.metadata).toMatchObject({
      header_count: '5',
      resolver: expect.any(String),
    });
    // No PII in the audit row.
    const blob = JSON.stringify(awaiting);
    expect(blob).not.toContain('mystery_'); // headers themselves never logged
  }, 60_000);

  it('3) handler returns cleanly — no NonRetryable, no exception', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/am-3.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx(
        ['novel_col_a', 'novel_col_b', 'novel_col_c', 'novel_col_d', 'novel_col_e'],
        [['x', 'y', 'z', 'q', 'r']],
      ),
    );
    const jobId = await createJob(org, r2Key);

    let threw: unknown = undefined;
    try {
      await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
  }, 60_000);

  it('4) duplicate alias in file → state=failed (NOT awaiting_mapping) — malformed input fails loud', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/am-4.xlsx`;
    // 'national_id' + 'ת.ז.' both alias to national_id canonical.
    storage.setObject(
      r2Key,
      await buildXlsx(
        ['national_id', 'ת.ז.', 'phone', 'name', 'apartment', 'address'],
        [['1', '2', '0501234567', 'Avi', '1', 'Herzl 10']],
      ),
    );
    const jobId = await createJob(org, r2Key);

    let caught: unknown;
    try {
      await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);

    const [row] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1),
    );
    // Duplicate-alias is malformed input — fail loud, NOT awaiting_mapping.
    expect(row?.status).toBe('failed');
  }, 60_000);
});
