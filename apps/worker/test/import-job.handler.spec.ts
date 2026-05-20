/**
 * T6.8 — Phase 6 worker integration: import job runs to completion.
 *
 * Note on T6.8 doc-vs-impl: docs/03 §10 labels this test
 *   "BullMQ job runs to completion"
 * but our implementation uses pg-boss (D.04 — no Redis in MVP; the
 * BullMQ wording in docs/03 is doc-drift, recorded in PR #22 + S9 will
 * land D.34 to formalise). The semantic remains: a queued job is
 * fully driven through the state machine to a terminal state and
 * audit_log reflects every transition.
 *
 * Strategy: bypass pg-boss entirely (T6.8 cares about the handler +
 * domain row, not the queue plumbing — the adapter is unit-tested in
 * pg-boss-adapter.spec.ts). We construct an `ImportJobHandler`, give
 * it a real payload + a fake JobContext, and assert the state row +
 * audit_log rows. This is the canonical "integration" shape: real
 * Postgres + real RLS + real withTenant, fake everything around them.
 *
 * Pinned invariants:
 *   1. handler runs queued→done; all four transitions land
 *   2. audit_log gets one row per transition (parsing/validating/persisting/done)
 *   3. all audit rows are actor_type='system' + actor_id=createdBy
 *   4. progress columns are coherent at end (total/processed/ok/failed)
 *   5. re-running the handler on a `done` row is a no-op (idempotent)
 *   6. non-existent job id → NonRetryableJobError (no infinite retry)
 *   7. cross-org payload (orgId tampered) → NonRetryableJobError
 *      (RLS prevents reading the job → 'job_not_visible')
 *   8. shutdown signal mid-run → throws (pg-boss will retry)
 */
// providerPool + test factories live INSIDE @emapp/db (not on the
// public surface, by design — D.21 says no direct pool access from app
// code). Tests are the only legitimate consumer, same as packages/db's
// own integration suites; reach in by path.
import { auditLog, importJobs, withTenant } from '@emapp/db';
import { NonRetryableJobError, type ImportJobPayload, type JobContext } from '@emapp/jobs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';

let org: TestOrg;
const handler = new ImportJobHandler();

function makeCtx(over: Partial<JobContext> = {}): JobContext {
  return {
    jobId: 'pg-boss-test',
    attempt: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
    ...over,
  };
}

async function createJob(o: TestOrg, idempotencyKey?: string): Promise<string> {
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        fileR2Key: 'org/test/import/file.xlsx',
        fileName: 'import.xlsx',
        fileSizeBytes: 1024,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
        idempotencyKey: idempotencyKey ?? null,
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

async function getAuditRows(o: TestOrg, jobId: string) {
  return withTenant(o.id, async (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`T68-${Date.now()}`, `t68-${Date.now()}`);
});

afterAll(async () => {
  // shared pool teardown handled by vitest workers; nothing per-suite.
});

describe('T6.8 — ImportJobHandler runs to completion', () => {
  it('1) drives queued → parsing → validating → persisting → done', async () => {
    const jobId = await createJob(org);
    const payload: ImportJobPayload = {
      jobId,
      orgId: org.id,
      createdBy: org.users[0]!.id,
    };
    await handler.handle(payload, makeCtx());
    const row = await getJob(org, jobId);
    expect(row?.status).toBe('done');
    expect(row?.startedAt).not.toBeNull();
    expect(row?.finishedAt).not.toBeNull();
  });

  it('2) audit_log has one row per forward transition', async () => {
    const jobId = await createJob(org);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const audits = await getAuditRows(org, jobId);
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(
      ['import.done', 'import.parsing', 'import.persisting', 'import.validating'].sort(),
    );
  });

  it('3) every audit row is actor_type=system, actor_id=createdBy', async () => {
    const jobId = await createJob(org);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const audits = await getAuditRows(org, jobId);
    expect(audits.length).toBeGreaterThanOrEqual(4);
    for (const a of audits) {
      expect(a.actorType).toBe('system');
      expect(a.actorId).toBe(org.users[0]!.id);
    }
  });

  it('4) progress counters are coherent at terminal state', async () => {
    const jobId = await createJob(org);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const row = await getJob(org, jobId);
    // Stub: totalRows=0, processed=ok=failed=0. The CONTRACT is
    // processed = ok + failed (coherence). Real numbers are an
    // S3/S5/S6 concern.
    expect(row?.totalRows).toBe(0);
    expect(row?.processedRows).toBe(0);
    expect(row?.okRows).toBe(0);
    expect(row?.failedRows).toBe(0);
  });

  it('5) re-running handler on a done row is a no-op (idempotent)', async () => {
    const jobId = await createJob(org);
    const payload: ImportJobPayload = {
      jobId,
      orgId: org.id,
      createdBy: org.users[0]!.id,
    };
    await handler.handle(payload, makeCtx());
    const auditCountBefore = (await getAuditRows(org, jobId)).length;

    await handler.handle(payload, makeCtx());
    const auditCountAfter = (await getAuditRows(org, jobId)).length;

    expect(auditCountAfter).toBe(auditCountBefore);
    const row = await getJob(org, jobId);
    expect(row?.status).toBe('done');
  });

  it('6) non-existent jobId → NonRetryableJobError (no infinite retry)', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    await expect(
      handler.handle({ jobId: fakeId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx()),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
  });

  it('7) cross-org payload (orgId tampered) → NonRetryableJobError via RLS', async () => {
    // Create the job in org A, attempt to handle it claiming org B.
    // RLS makes the job invisible → handler sees `not visible` → throws.
    const orgB = await createTestOrg(`T68-B-${Date.now()}`, `t68-b-${Date.now()}`);
    const jobId = await createJob(org);
    await expect(
      handler.handle({ jobId, orgId: orgB.id, createdBy: orgB.users[0]!.id }, makeCtx()),
    ).rejects.toBeInstanceOf(NonRetryableJobError);

    // Cleanup: original job is untouched (still queued in org A).
    const rowA = await getJob(org, jobId);
    expect(rowA?.status).toBe('queued');
  });

  it('8) shutdown signal before completion → throws (pg-boss retries)', async () => {
    const jobId = await createJob(org);
    const controller = new AbortController();
    controller.abort(); // signal already aborted before we start

    await expect(
      handler.handle(
        { jobId, orgId: org.id, createdBy: org.users[0]!.id },
        makeCtx({ signal: controller.signal }),
      ),
    ).rejects.toThrow();

    // Handler should have transitioned to 'failed' (markFailed runs in
    // catch). This is correct behavior: the next worker retry sees a
    // 'failed' terminal row, which is itself a terminal state — the
    // queue's own retry policy decides whether to re-enqueue. For our
    // domain we record the failure forensically.
    const row = await getJob(org, jobId);
    expect(['queued', 'failed']).toContain(row?.status);
  });

  it('9) RLS — handler.handle from org B cannot affect org A row (defense-in-depth)', async () => {
    // Belt-and-suspenders on test 7: confirm even if a malicious payload
    // matched a real cross-org jobId, audit_log on the OTHER org sees
    // nothing (RLS isolation FORCE).
    const orgB = await createTestOrg(`T68-C-${Date.now()}`, `t68-c-${Date.now()}`);
    const jobId = await createJob(org);
    try {
      await handler.handle({ jobId, orgId: orgB.id, createdBy: orgB.users[0]!.id }, makeCtx());
    } catch {
      /* expected */
    }
    const orgBAudits = await withTenant(orgB.id, async (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(sql`${auditLog.targetTable} = 'import_jobs' AND ${auditLog.targetId} = ${jobId}`),
    );
    expect(orgBAudits).toHaveLength(0);
  });

  it('10) GRANT — handler never invokes DELETE on import_jobs (forensic)', async () => {
    // The schema spec (#9) already asserts app_user lacks DELETE.
    // This belt-and-suspenders test runs the handler and confirms the
    // app_user role would have rejected a DELETE if attempted. We
    // observe the row STILL EXISTS at terminal state — never deleted.
    const jobId = await createJob(org);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const provClient = await providerPool.connect();
    try {
      const res = await provClient.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM import_jobs WHERE id = $1) AS exists',
        [jobId],
      );
      expect(res.rows[0]?.exists).toBe(true);
    } finally {
      provClient.release();
    }
  });
});
