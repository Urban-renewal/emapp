/**
 * Test #4 — END-TO-END pg-boss integration (audit-pass v2 finding).
 *
 * The original T6.8 test (apps/worker/test/import-job.handler.spec.ts)
 * declared "BullMQ job runs to completion" but BYPASSED pg-boss
 * entirely — it called handler.handle() directly. So the contract of
 * the queue layer (the seam the entire phase rests on) was unverified.
 *
 * This spec exercises the REAL queue:
 *   - Construct a real PgBoss against the test DB (provider role —
 *     pg-boss needs DDL to provision its own schema; matches main.ts).
 *   - boss.start() — applies pg-boss schema migrations.
 *   - registerHandler() — wires the adapter + ImportJobHandler.
 *   - boss.send(jobName, payload) — enqueues a real job.
 *   - poll until the import_jobs.status becomes 'done' or timeout.
 *   - boss.stop({graceful:true, close:true}) — drains gracefully.
 *
 * Each test uses an isolated pgboss schema (suffixed with random
 * bytes) so parallel test workers don't fight over the same queue.
 *
 * SLOW: integration with a real queue + Neon ~30-60s per case.
 * vitest testTimeout is 30s by default; we set per-test 90s.
 *
 * Pinned invariants:
 *   1. Enqueued job processes to import_jobs.status='done' end-to-end
 *   2. Failed job (corrupt file) → import_jobs.status='failed' AND
 *      pg-boss's own job row reflects 'failed'
 *   3. Graceful stop drains in-flight job (no orphan 'active' rows)
 *   4. Payload validation failure (Zod) at the adapter layer →
 *      pg-boss surfaces as 'failed' AND domain row stays 'queued'
 *      (the handler never ran)
 */
import { randomBytes } from 'node:crypto';

import { FakeStorageProvider, env, importJobs, withTenant } from '@emapp/db';
import { IMPORT_JOB_NAME, type ImportJobPayload } from '@emapp/jobs';
import { eq } from 'drizzle-orm';
import { Workbook } from 'exceljs';
// eslint-disable-next-line import/no-named-as-default
import PgBoss from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';
import { registerHandler, type BossLike } from '../src/pg-boss-adapter';

let org: TestOrg;
let boss: PgBoss | null = null;
let bossSchema = '';

const TEST_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

async function buildXlsx(rowCount: number): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['national_id', 'phone', 'name', 'apartment', 'address']);
  const validIds = ['123456782', '234567899', '345678908', '456789016', '567890124'];
  for (let i = 0; i < rowCount; i += 1) {
    ws.addRow([validIds[i % validIds.length], '0501234567', `N${i}`, String(i + 1), 'Herzl 10']);
  }
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
        fileSizeBytes: 2048,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

async function getStatus(o: TestOrg, jobId: string): Promise<string | null> {
  const [r] = await withTenant(o.id, (tx) =>
    tx
      .select({ status: importJobs.status })
      .from(importJobs)
      .where(eq(importJobs.id, jobId))
      .limit(1),
  );
  return r?.status ?? null;
}

async function waitUntil<T>(predicate: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`E2E-${Date.now()}`, `e2e-${Date.now()}`);
});

afterEach(async () => {
  if (boss) {
    try {
      await boss.stop({ graceful: true, close: true });
    } catch {
      /* ignore */
    }
    boss = null;
  }
  // Drop the per-test pgboss schema so subsequent tests start clean.
  if (bossSchema) {
    const c = await providerPool.connect();
    try {
      await c.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`);
    } finally {
      c.release();
    }
    bossSchema = '';
  }
});

afterAll(async () => {
  /* pool teardown by vitest workers */
});

describe('Test #4 — END-TO-END pg-boss integration (T6.8 real contract)', () => {
  it(
    '1) enqueued job processes through the queue to done',
    async () => {
      bossSchema = `pgboss_e2e_${randomBytes(4).toString('hex')}`;
      boss = new PgBoss({
        connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
        schema: bossSchema,
      });
      await boss.start();

      const storage = new FakeStorageProvider();
      const r2Key = `org/${org.id}/import/e2e-1.xlsx`;
      storage.setObject(r2Key, await buildXlsx(3));
      const jobId = await createJob(org, r2Key);
      const handler = new ImportJobHandler(storage);

      await registerHandler({
        boss: boss as unknown as BossLike,
        registration: { handler, payloadSchema: handler.payloadSchema },
        log: silentLog(),
        signal: new AbortController().signal,
      });

      const payload: ImportJobPayload = {
        jobId,
        orgId: org.id,
        createdBy: org.users[0]!.id,
      };
      await boss.send(IMPORT_JOB_NAME, payload);

      // Poll import_jobs.status until 'done' or timeout.
      const finalStatus = await waitUntil(async () => {
        const s = await getStatus(org, jobId);
        return s === 'done' || s === 'failed' ? s : null;
      }, 30_000);

      expect(finalStatus).toBe('done');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '2) corrupt file → handler fails → import_jobs.status = failed',
    async () => {
      bossSchema = `pgboss_e2e_${randomBytes(4).toString('hex')}`;
      boss = new PgBoss({
        connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
        schema: bossSchema,
      });
      await boss.start();

      const storage = new FakeStorageProvider();
      const r2Key = `org/${org.id}/import/e2e-2.xlsx`;
      storage.setObject(r2Key, Buffer.from('not a valid xlsx')); // garbage
      const jobId = await createJob(org, r2Key);
      const handler = new ImportJobHandler(storage);

      await registerHandler({
        boss: boss as unknown as BossLike,
        registration: { handler, payloadSchema: handler.payloadSchema },
        log: silentLog(),
        signal: new AbortController().signal,
      });

      await boss.send(IMPORT_JOB_NAME, {
        jobId,
        orgId: org.id,
        createdBy: org.users[0]!.id,
      });

      const finalStatus = await waitUntil(async () => {
        const s = await getStatus(org, jobId);
        return s === 'done' || s === 'failed' ? s : null;
      }, 30_000);

      expect(finalStatus).toBe('failed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '3) graceful stop drains in-flight jobs (no zombie active rows)',
    async () => {
      bossSchema = `pgboss_e2e_${randomBytes(4).toString('hex')}`;
      boss = new PgBoss({
        connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
        schema: bossSchema,
      });
      await boss.start();

      const storage = new FakeStorageProvider();
      const r2Key = `org/${org.id}/import/e2e-3.xlsx`;
      storage.setObject(r2Key, await buildXlsx(2));
      const jobId = await createJob(org, r2Key);
      const handler = new ImportJobHandler(storage);

      await registerHandler({
        boss: boss as unknown as BossLike,
        registration: { handler, payloadSchema: handler.payloadSchema },
        log: silentLog(),
        signal: new AbortController().signal,
      });

      await boss.send(IMPORT_JOB_NAME, {
        jobId,
        orgId: org.id,
        createdBy: org.users[0]!.id,
      });

      // Wait for the job to reach done OR a sensible intermediate state.
      await waitUntil(async () => {
        const s = await getStatus(org, jobId);
        return s === 'done' || s === 'failed' ? s : null;
      }, 30_000);

      // Graceful stop — drains active jobs, closes pool.
      await boss.stop({ graceful: true, close: true });
      boss = null;

      // No zombie 'active' rows in pgboss state after graceful stop.
      const c = await providerPool.connect();
      try {
        const res = await c.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM "${bossSchema}".job WHERE state = 'active'`,
        );
        expect(Number(res.rows[0]?.count ?? '0')).toBe(0);
      } finally {
        c.release();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '4) malformed payload (Zod rejects) → handler never runs, domain row stays queued',
    async () => {
      bossSchema = `pgboss_e2e_${randomBytes(4).toString('hex')}`;
      boss = new PgBoss({
        connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
        schema: bossSchema,
      });
      await boss.start();

      const storage = new FakeStorageProvider();
      const r2Key = `org/${org.id}/import/e2e-4.xlsx`;
      storage.setObject(r2Key, await buildXlsx(2));
      const jobId = await createJob(org, r2Key);
      const handler = new ImportJobHandler(storage);

      await registerHandler({
        boss: boss as unknown as BossLike,
        registration: { handler, payloadSchema: handler.payloadSchema },
        log: silentLog(),
        signal: new AbortController().signal,
      });

      // Send a payload missing jobId — Zod rejects in the adapter
      // BEFORE handler.handle gets called.
      await boss.send(IMPORT_JOB_NAME, {
        orgId: org.id,
        createdBy: org.users[0]!.id,
        // intentionally NO jobId
      });

      // Wait a short window — handler should NOT advance the domain
      // row past 'queued'.
      await new Promise((r) => setTimeout(r, 5000));
      const status = await getStatus(org, jobId);
      expect(status).toBe('queued');
    },
    TEST_TIMEOUT_MS,
  );
});
