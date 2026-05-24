/**
 * Test #1 (integration half) — end-to-end PII non-leak in audit_log.
 *
 * Trigger the handler's real failure path (corrupt file → markFailed)
 * against the real DB, then SELECT * from audit_log for the job and
 * assert that nothing in the row (metadata, before_state, after_state)
 * carries a value that looks like a national_id, phone, or any cell
 * data from the offending file.
 *
 * This is a defense-in-depth pin: the unit tests
 * (audit-sanitiser.spec.ts) verify the sanitiser's contract; this spec
 * verifies the END-TO-END pipeline through the handler + AuditService
 * + actual jsonb storage round-trip.
 */
import { auditLog, FakeStorageProvider, importJobs, withTenant } from '@emapp/db';
import { type ImportJobPayload, type JobContext } from '@emapp/jobs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

async function createJob(o: TestOrg, r2Key: string): Promise<string> {
  // projectId required as of audit-pass v3 D5 — see audit-c5-received.spec.ts.
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

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`AUDIT-${Date.now()}`, `audit-${Date.now()}`);
});

afterAll(async () => {
  /* shared pool teardown by vitest workers */
});

describe('Test #1 integration — audit_log carries NO PII end-to-end', () => {
  it('1) corrupt file path → audit_log.metadata has only structural fields', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/corrupt.xlsx`;
    // Seed with a value that looks like a national_id so we can grep
    // for it in the persisted audit row.
    const SECRET_LIKE_VALUE = '987654321';
    storage.setObject(r2Key, Buffer.from(`bogus-${SECRET_LIKE_VALUE}-bytes`));

    const jobId = await createJob(org, r2Key);
    const payload: ImportJobPayload = {
      jobId,
      orgId: org.id,
      createdBy: org.users[0]!.id,
    };

    try {
      await handler.handle(payload, makeCtx());
    } catch {
      /* expected */
    }

    const rows = await withTenant(org.id, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
    );

    // Walk every persisted audit row and assert no field contains the
    // secret-like value. Includes metadata + every other column.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      const blob = JSON.stringify(row);
      expect(blob, `audit row ${row.id} carries the secret-like value`).not.toContain(
        SECRET_LIKE_VALUE,
      );
    }

    // The `import.failed` row should exist (markFailed ran) and its
    // metadata should be the structured FailureAuditSummary shape.
    const failedRow = rows.find((r) => r.action === 'import.failed');
    expect(failedRow).toBeDefined();
    expect(failedRow!.metadata).toMatchObject({
      error_class: expect.any(String),
    });
    // Make sure the OLD shape (`reason`) does not regress.
    expect(failedRow!.metadata).not.toHaveProperty('reason');
  });

  it('2) every transition row has metadata that is a flat string-or-null record', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/bad-${Date.now()}.xlsx`;
    storage.setObject(r2Key, Buffer.from('bytes that are not xlsx'));
    const jobId = await createJob(org, r2Key);
    try {
      await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    } catch {
      /* expected */
    }

    const rows = await withTenant(org.id, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
    );

    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      // Every leaf in metadata must be string|null. No nested objects,
      // no arrays — those are growth surfaces that could carry values.
      for (const [k, v] of Object.entries(meta)) {
        if (v === null) continue;
        // We allow the existing 'from'/'to'/'pg_boss_job_id' fields
        // (transition rows). For 'import.failed' we expect only the
        // FailureAuditSummary keys.
        expect(typeof v, `audit row ${row.id} meta.${k} is not string|null`).toBe('string');
      }
    }
  });
});
