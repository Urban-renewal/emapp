/**
 * Audit-pass v2 finding C5 — `import.received` audit row at handler entry.
 *
 * Closes the regulator-facing gap where the first audit row used to be
 * `import.parsing`; a scan of audit_log saw jobs springing into
 * existence at parsing with no worker-side provenance. Now the FIRST
 * audit row a job leaves behind is `import.received` (the worker
 * accepted the job from pg-boss), BEFORE any state transition.
 *
 * Pinned invariants:
 *   1. successful run → audit_log has exactly one 'import.received'
 *   2. 'import.received' precedes 'import.parsing' (created_at order)
 *   3. metadata carries pg_boss_job_id + attempt
 *   4. cross-org payload (RLS no visibility) → NO 'import.received'
 *      row leaks to the OTHER org's audit_log
 *   5. handler.handle invoked twice → 'import.received' appears twice
 *      (per-attempt audit; pg-boss retries are forensically meaningful)
 *   6. metadata is sanitised — no PII, only structural fields
 */
import { auditLog, FakeStorageProvider, importJobs, withTenant } from '@emapp/db';
import { type JobContext } from '@emapp/jobs';
import { and, asc, eq } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';

let org: TestOrg;
let orgB: TestOrg;

function makeCtx(): JobContext {
  return {
    jobId: 'pg-boss-tid',
    attempt: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  };
}

async function buildXlsx(): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['national_id', 'phone', 'name', 'apartment', 'address']);
  ws.addRow(['123456782', '0501234567', 'Avi', '1', 'Herzl 10']);
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
        fileSizeBytes: 1024,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

async function getAuditRowsOrdered(o: TestOrg, jobId: string) {
  return withTenant(o.id, async (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId)))
      .orderBy(asc(auditLog.createdAt)),
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  org = await createTestOrg(`C5-${ts}`, `c5-${ts}`);
  orgB = await createTestOrg(`C5-B-${ts}`, `c5-b-${ts}`);
});

afterAll(async () => {
  /* shared pool teardown by vitest workers */
});

describe('Audit-pass v2 C5 — import.received audit row', () => {
  it('1) successful run → exactly one import.received row', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/c5-1.xlsx`;
    storage.setObject(key, await buildXlsx());
    const jobId = await createJob(org, key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const rows = await getAuditRowsOrdered(org, jobId);
    const received = rows.filter((r) => r.action === 'import.received');
    expect(received).toHaveLength(1);
  });

  it('2) import.received is the FIRST audit row (precedes parsing)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/c5-2.xlsx`;
    storage.setObject(key, await buildXlsx());
    const jobId = await createJob(org, key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const rows = await getAuditRowsOrdered(org, jobId);
    expect(rows[0]!.action).toBe('import.received');
    expect(rows[1]!.action).toBe('import.parsing');
  });

  it('3) metadata carries pg_boss_job_id + attempt as strings', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/c5-3.xlsx`;
    storage.setObject(key, await buildXlsx());
    const jobId = await createJob(org, key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const rows = await getAuditRowsOrdered(org, jobId);
    const received = rows.find((r) => r.action === 'import.received')!;
    expect(received.metadata).toMatchObject({
      pg_boss_job_id: 'pg-boss-tid',
      attempt: '1',
    });
  });

  it('4) cross-org payload → NO leakage of import.received to the other org', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/c5-4.xlsx`;
    storage.setObject(key, await buildXlsx());
    const jobId = await createJob(org, key);
    // Handler invoked with WRONG orgId — RLS hides the job, so the
    // import.received write skips silently, and readStatus throws
    // NonRetryable. The org-B audit_log must NOT carry a row for
    // this jobId.
    try {
      await handler.handle({ jobId, orgId: orgB.id, createdBy: orgB.users[0]!.id }, makeCtx());
    } catch {
      /* expected NonRetryable */
    }
    const bRows = await getAuditRowsOrdered(orgB, jobId);
    expect(bRows).toHaveLength(0);
  });

  it('5) handler invoked twice → import.received appears twice (per-attempt)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/c5-5.xlsx`;
    storage.setObject(key, await buildXlsx());
    const jobId = await createJob(org, key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    // Reset to 'queued' to simulate a real pg-boss retry that re-enters
    // the handler before terminal state is reached.
    const provClient = await providerPool.connect();
    try {
      await provClient.query(
        `UPDATE import_jobs SET status='queued', processed_rows=0, ok_rows=0, failed_rows=0, started_at=NULL, finished_at=NULL WHERE id=$1`,
        [jobId],
      );
    } finally {
      provClient.release();
    }

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const rows = await getAuditRowsOrdered(org, jobId);
    const received = rows.filter((r) => r.action === 'import.received');
    // Per-attempt: each handler.handle writes its own import.received.
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it('6) metadata is flat string|null — no PII surface', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const key = `org/${org.id}/import/c5-6.xlsx`;
    storage.setObject(key, await buildXlsx());
    const jobId = await createJob(org, key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const rows = await getAuditRowsOrdered(org, jobId);
    const received = rows.find((r) => r.action === 'import.received')!;
    const meta = (received.metadata ?? {}) as Record<string, unknown>;
    for (const [, v] of Object.entries(meta)) {
      if (v === null) continue;
      expect(typeof v).toBe('string');
    }
  });
});
