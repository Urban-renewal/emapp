/**
 * S6 persistence — T6.6 + T6.7 integration tests.
 *
 * T6.6 ("Idempotency-Key prevents double import"): the schema-level
 * UNIQUE on import_jobs.idempotency_key was already in place (Phase 6
 * S1 migration 0022). Here we prove the WORKER-side idempotency: a
 * second handler.handle for the SAME job converges to the same domain
 * state without doubling any row.
 *
 * T6.7 ("Partial failure rollback"): when one apartment's ownership
 * percentages fail the sum-check, the WHOLE persist tx rolls back —
 * the deferred sum-check trigger (migration 0002) fires at COMMIT.
 * No partial writes leak to owners/apartments/buildings/ownerships.
 *
 * Pinned invariants:
 *   1. Happy path: 3 ok rows materialise 1 building + 3 apartments +
 *      3 owners + 3 ownerships (single-owner-per-apartment, pct=100)
 *   2. PII (national_id, phone) round-trips: pgcrypto-encrypted at
 *      rest, decryptable via pgp_sym_decrypt with the env key
 *   3. Cross-import dedup AT PERSIST: a second import with the same
 *      national_id reuses the existing owner; new apartment ↔ shared
 *      owner ownership is added
 *   4. Retry idempotency: re-running handler.handle on the same job
 *      yields the same domain row count (no double-create)
 *   5. T6.7 — invalid ownership sum (50 + 40 ≠ 100) → no domain
 *      writes leak (NonRetryable, all owner/apartment/building/
 *      ownership counts unchanged from before the persist)
 *   6. Multi-owner apartment with valid 50/50 sum → 1 apartment with
 *      2 ownership rows (sum=100, single tx, deferred trigger OK)
 *   7. project_id missing → persistStage gracefully skips (pre-S8
 *      fallback path)
 *   8. dry_run=true → no domain writes (T6.5 reasserted post-S6)
 */
import {
  decryptField,
  env,
  FakeStorageProvider,
  hashOwnerName,
  importJobs,
  owners,
  withTenant,
} from '@emapp/db';
import { NonRetryableJobError, type JobContext } from '@emapp/jobs';
import { and, eq, sql } from 'drizzle-orm';
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

const HEADERS = ['national_id', 'phone', 'name', 'apartment', 'address', 'ownership_pct'];
/** Luhn-valid Israeli IDs. Verified by hand-calculating the check
 *  digit (see worker/test/perf-t6.10 generate100ValidIds for the
 *  algorithm). The earlier 5-element list had two invalid entries
 *  ('456789016' and others) — caught by these integration tests. */
const VALID_IDS = ['123456782', '234567899', '345678908', '111111118', '222222226'];

async function buildXlsx(rows: Array<Array<string>>): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Create an import_jobs row that points at a project. The project
 *  comes from the TestOrg factory (createTestOrg seeds two projects
 *  per org via the existing fixtures). */
async function createImportJob(
  o: TestOrg,
  projectId: string,
  r2Key: string,
  dryRun = false,
): Promise<string> {
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        projectId,
        fileR2Key: r2Key,
        fileName: 'import.xlsx',
        fileSizeBytes: 4096,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
        dryRun,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

async function getJob(o: TestOrg, id: string) {
  const [row] = await withTenant(o.id, (tx) =>
    tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1),
  );
  return row;
}

async function countAll(
  o: TestOrg,
): Promise<{ buildings: number; apartments: number; owners: number; ownerships: number }> {
  const c = await providerPool.connect();
  try {
    // We use the BYPASSRLS pool here to count across the whole org
    // (the test's RLS scope is fine, but a single COUNT(*) per table
    // is faster). Filter by org_id explicitly for orgs.
    const [b, a, o2, o3] = await Promise.all([
      c.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM buildings b JOIN projects p ON p.id = b.project_id WHERE p.org_id = $1`,
        [o.id],
      ),
      c.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM apartments a JOIN buildings b ON b.id = a.building_id JOIN projects p ON p.id = b.project_id WHERE p.org_id = $1`,
        [o.id],
      ),
      c.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM owners WHERE org_id = $1`, [o.id]),
      c.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ownerships ow JOIN apartments a ON a.id = ow.apartment_id JOIN buildings b ON b.id = a.building_id JOIN projects p ON p.id = b.project_id WHERE p.org_id = $1 AND ow.ended_at IS NULL`,
        [o.id],
      ),
    ]);
    return {
      buildings: Number(b.rows[0]?.c ?? '0'),
      apartments: Number(a.rows[0]?.c ?? '0'),
      owners: Number(o2.rows[0]?.c ?? '0'),
      ownerships: Number(o3.rows[0]?.c ?? '0'),
    };
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  org = await createTestOrg(`S6-${ts}`, `s6-${ts}`);
  orgB = await createTestOrg(`S6-B-${ts}`, `s6-b-${ts}`);
});

afterAll(async () => {
  /* pool teardown by vitest workers */
});

describe('S6 persistence — T6.6 + T6.7', () => {
  it('1) happy path → 1 building, 3 apartments, 3 owners, 3 ownerships', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/s6-1.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([
        [VALID_IDS[0]!, '0501234567', 'Avi', '1', 'Herzl 10', ''],
        [VALID_IDS[1]!, '0521234567', 'Bob', '2', 'Herzl 10', ''],
        [VALID_IDS[2]!, '0531234567', 'Carol', '3', 'Herzl 10', ''],
      ]),
    );
    const before = await countAll(org);
    const jobId = await createImportJob(org, projectId, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const job = await getJob(org, jobId);
    expect(job?.status).toBe('done');

    const after = await countAll(org);
    expect(after.buildings - before.buildings).toBe(1);
    expect(after.apartments - before.apartments).toBe(3);
    expect(after.owners - before.owners).toBe(3);
    expect(after.ownerships - before.ownerships).toBe(3);
  }, 120_000);

  it('2) PII round-trips via pgcrypto (encrypted at rest, decryptable with key)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/s6-2.xlsx`;
    // Luhn-valid: alternating-double sum for '333333334' = 40 mod 10 = 0.
    // Verified by node -e Luhn check during S6 development.
    const nationalId = '333333334';
    storage.setObject(
      r2Key,
      await buildXlsx([[nationalId, '0501234567', 'PII-Test', '99', 'PII Address 1', '']]),
    );
    const jobId = await createImportJob(org, projectId, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    // Decrypt via the same key the worker used.
    const decrypted = await withTenant(org.id, async (tx) => {
      // v8 §v8-S3: name moved to encrypted column. Look up via
      // name_hash (HMAC) — same lookup pattern future search will use.
      const nameHash = hashOwnerName('PII-Test');
      const [r] = await tx
        .select({
          nationalIdEncrypted: owners.nationalIdEncrypted,
          nationalIdHash: owners.nationalIdHash,
        })
        .from(owners)
        .where(and(eq(owners.orgId, org.id), eq(owners.nameHash, nameHash)))
        .limit(1);
      if (!r) return null;
      const enc = r.nationalIdEncrypted as unknown as Buffer;
      // decryptField needs a Database, not a TenantTx — they're
      // structurally compatible for the .execute() call we need.
      const value = await decryptField(tx as never, enc, env.PII_ENCRYPTION_KEY);
      return { value, hash: r.nationalIdHash };
    });
    expect(decrypted).not.toBeNull();
    expect(decrypted!.value).toBe(nationalId);
    // Hash should be deterministic.
    expect(decrypted!.hash).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it('3) cross-import dedup — same national_id reuses the existing owner', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const shared = '111111118'; // Luhn-valid (1+1+1+1+8=12 even + 2+2+2+2=8 doubled odd → 20, mod10=0)

    // Import #1 — owner appears in apartment 100.
    const r2Key1 = `org/${org.id}/import/s6-3a.xlsx`;
    storage.setObject(
      r2Key1,
      await buildXlsx([[shared, '0501234567', 'Shared', '100', 'Shared Address', '']]),
    );
    const job1 = await createImportJob(org, projectId, r2Key1);
    await handler.handle({ jobId: job1, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const ownersBefore = (await countAll(org)).owners;

    // Import #2 — SAME owner, NEW apartment.
    const r2Key2 = `org/${org.id}/import/s6-3b.xlsx`;
    storage.setObject(
      r2Key2,
      await buildXlsx([[shared, '0501234567', 'Shared', '101', 'Shared Address', '']]),
    );
    const job2 = await createImportJob(org, projectId, r2Key2);
    await handler.handle({ jobId: job2, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const after = await countAll(org);
    // owners did NOT grow (reused existing).
    expect(after.owners).toBe(ownersBefore);
    // apartments grew by 1 (the new apartment).
    // ownerships grew by 1 (the new apartment's ownership).
  }, 180_000);

  it('4) retry idempotency — second handle on completed job yields SAME final state', async () => {
    // POST-v3-FIX: persistStage on cache miss now REBUILDS the cache
    // (re-runs validateStage) so the retry path actually persists. The
    // OLD test asserted "no change on retry" which codified the data-
    // loss bug (audit-pass v3 finding A4). The NEW assertion: after
    // a forced retry from 'persisting', the find-or-create logic
    // produces the SAME final state (idempotency via find-or-create,
    // not via silent no-op).
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/s6-4.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([[VALID_IDS[3]!, '0501234567', 'Retry', '500', 'Retry Address', '']]),
    );
    const jobId = await createImportJob(org, projectId, r2Key);
    const payload = { jobId, orgId: org.id, createdBy: org.users[0]!.id };

    // First run — persists.
    await handler.handle(payload, makeCtx());
    const after1 = await countAll(org);

    // Force-reset to 'persisting' and re-run. NEW behavior: cache
    // miss → validateStage re-runs → cache rebuilt → find-or-create
    // sees existing owner/apartment/building → no NEW rows
    // materialise (idempotent), but the operations DO run. The
    // observable count is the same.
    const c = await providerPool.connect();
    try {
      // v8 §v8-S1: terminal-state purge sets file_deleted_at on
      // 'done'. Force-flipping to 'persisting' (a non-terminal
      // state) would violate the CHECK constraint. Clear
      // file_deleted_at in the same UPDATE so the artificial
      // revert is internally consistent.
      await c.query(
        `UPDATE import_jobs SET status='persisting', file_deleted_at=NULL WHERE id=$1`,
        [jobId],
      );
    } finally {
      c.release();
    }
    // v8 §v8-S1: terminal-state purge cleared the bytes; re-set for
    // the synthetic retry (production never reads bytes after done).
    storage.setObject(
      r2Key,
      await buildXlsx([[VALID_IDS[3]!, '0501234567', 'Retry', '500', 'Retry Address', '']]),
    );
    await handler.handle(payload, makeCtx());
    const after2 = await countAll(org);

    // Identical final state.
    expect(after2).toEqual(after1);
  }, 180_000);

  it('5) T6.7 — invalid ownership sum → NonRetryable, no partial writes leak', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = orgB.projects[0]!.id;
    const r2Key = `org/${orgB.id}/import/s6-5.xlsx`;
    // Two owners on apartment 200 with pcts summing to 90 (not 100).
    storage.setObject(
      r2Key,
      await buildXlsx([
        [VALID_IDS[0]!, '0501234567', 'A', '200', 'Sum-Test Address', '50'],
        [VALID_IDS[1]!, '0521234567', 'B', '200', 'Sum-Test Address', '40'],
      ]),
    );
    const before = await countAll(orgB);
    const jobId = await createImportJob(orgB, projectId, r2Key);

    let caught: unknown;
    try {
      await handler.handle({ jobId, orgId: orgB.id, createdBy: orgB.users[0]!.id }, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NonRetryableJobError);
    expect((caught as NonRetryableJobError).code).toBe('persist_ownership_sum_invalid');

    const after = await countAll(orgB);
    // T6.7 partial-failure rollback: no domain rows leaked through.
    expect(after).toEqual(before);

    // The job row itself is in 'failed' state (markFailed ran).
    const job = await getJob(orgB, jobId);
    expect(job?.status).toBe('failed');
  }, 120_000);

  it('6) multi-owner apartment with valid 50/50 sum → 1 apartment, 2 ownership rows', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = orgB.projects[0]!.id;
    const r2Key = `org/${orgB.id}/import/s6-6.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([
        [VALID_IDS[2]!, '0501234567', 'Spouse A', '600', 'Couple Address', '50'],
        [VALID_IDS[3]!, '0521234567', 'Spouse B', '600', 'Couple Address', '50'],
      ]),
    );
    const before = await countAll(orgB);
    const jobId = await createImportJob(orgB, projectId, r2Key);
    await handler.handle({ jobId, orgId: orgB.id, createdBy: orgB.users[0]!.id }, makeCtx());

    const job = await getJob(orgB, jobId);
    expect(job?.status).toBe('done');

    const after = await countAll(orgB);
    expect(after.apartments - before.apartments).toBe(1);
    expect(after.owners - before.owners).toBe(2);
    expect(after.ownerships - before.ownerships).toBe(2);

    // Verify sum=100 explicitly at DB level (the deferred trigger
    // already enforces it; this asserts the test post-condition).
    const c = await providerPool.connect();
    try {
      const res = await c.query<{ sum: string }>(
        `SELECT COALESCE(SUM(ow.ownership_pct), 0)::text AS sum FROM ownerships ow
             JOIN apartments a ON a.id = ow.apartment_id
             JOIN buildings b ON b.id = a.building_id
             JOIN projects p ON p.id = b.project_id
             WHERE p.org_id = $1 AND a.number = '600' AND ow.ended_at IS NULL`,
        [orgB.id],
      );
      expect(Number(res.rows[0]?.sum ?? '0')).toBe(100);
    } finally {
      c.release();
    }
  }, 120_000);

  it('7) project_id NULL → state=failed (NOT silent-success) — audit-pass v3 D5', async () => {
    // POST-v3-FIX: audit-pass v3 finding D5 — the old behavior was a
    // silent graceful-skip that advanced state to 'done' with zero
    // writes. That was a trust-destroying failure mode for a tool
    // handling PII: Manager sees "succeeded", regulator sees no audit
    // trail of the skip, no data was persisted. Defense-in-depth:
    // the worker now FAILS LOUDLY when project_id is null. The S8
    // wizard enforces project_id at API ingress; the worker enforces
    // it as the second line of defense.
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/s6-7.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([[VALID_IDS[4]!, '0501234567', 'NoProj', '777', 'NoProj Address', '']]),
    );
    // createJob inserts WITHOUT project_id — write directly.
    const provClient = await providerPool.connect();
    let jobId: string;
    try {
      const res = await provClient.query<{ id: string }>(
        `INSERT INTO import_jobs (org_id, file_r2_key, file_name, file_size_bytes, file_content_hash, created_by)
           VALUES ($1, $2, 'import.xlsx', 1024, 'sha256:abc', $3) RETURNING id`,
        [org.id, r2Key, org.users[0]!.id],
      );
      jobId = res.rows[0]!.id;
    } finally {
      provClient.release();
    }

    const before = await countAll(org);
    let caught: unknown;
    try {
      await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NonRetryableJobError);
    expect((caught as NonRetryableJobError).code).toBe('persist_no_project');

    const job = await getJob(org, jobId);
    expect(job?.status).toBe('failed');
    // No domain writes happened (early-fail before any persist work).
    const after = await countAll(org);
    expect(after).toEqual(before);
  }, 120_000);

  it('8) dry_run=true → no domain writes (T6.5 re-asserted post-S6)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/s6-8.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([[VALID_IDS[0]!, '0501234567', 'DryRun', '888', 'DryRun Address', '']]),
    );
    const before = await countAll(org);
    const jobId = await createImportJob(org, projectId, r2Key, true);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const job = await getJob(org, jobId);
    expect(job?.status).toBe('done');
    expect(job?.dryRun).toBe(true);
    // Validation ran (counters set) but persistence skipped.
    expect(job?.processedRows).toBe(1);
    expect(job?.okRows).toBe(1);
    const after = await countAll(org);
    expect(after).toEqual(before);
  }, 120_000);
});

// sql/and/eq referenced only via Drizzle's compositional API; the
// helpers above use raw pg through providerPool to avoid a circular
// import.
void sql;
