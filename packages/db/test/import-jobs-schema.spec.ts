/**
 * Phase 6 — import_jobs/import_job_errors schema invariants.
 *
 * Pinned by the audit-pass that preceded S2: the schema decisions that
 * landed in migrations 0022 + 0023 are load-bearing for every later
 * slice (parsing, validation, persistence, audit). These tests assert
 * the CONTRACT each later slice can rely on:
 *
 *   1. RLS — cross-org reads invisible (D.07 Layer 9, A.9.4)
 *   2. RLS — withTenant returns rows only for the matching org
 *   3. CHECK — status enum fail-closed (no `invalid` slips through)
 *   4. CHECK — file_size > 0 (rejects empty Excel upload)
 *   5. CHECK — file_size ≤ 50MB (docs/03 §10 mandate)
 *   6. UNIQUE — idempotency (org, key) — D.22 F second-POST guard
 *   7. UNIQUE — NULL idempotency_key allowed multiple times (partial idx)
 *   8. CASCADE — child errors gone when parent job deleted
 *   9. GRANT — app_user has SELECT/INSERT/UPDATE but NO DELETE
 *      (forensic — only provider-admin via raw SQL can remove)
 *  10. PII compliance — `raw_row` column does NOT exist (0023 dropped it)
 *
 * Run via `pnpm --filter @emapp/db test` against the dev Neon DB
 * (global-setup runs migrations before workers start). Each test uses
 * a unique org so suites can run in parallel.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool, providerPool } from '../src/client';
import { importJobErrors, importJobs } from '../src/schema/imports';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

let orgA: TestOrg;
let orgB: TestOrg;

const VALID_R2_KEY = 'org/test/import/file.xlsx';
const VALID_HASH = 'sha256:abc123';

interface ImportJobInsertable {
  orgId: string;
  status?: 'queued' | 'parsing' | 'validating' | 'persisting' | 'done' | 'failed' | 'cancelled';
  fileR2Key: string;
  fileName: string;
  fileSizeBytes: number;
  fileContentHash: string;
  createdBy: string;
  idempotencyKey?: string | null;
  dryRun?: boolean;
}

function jobRow(org: TestOrg, over: Partial<ImportJobInsertable> = {}): ImportJobInsertable {
  return {
    orgId: org.id,
    fileR2Key: VALID_R2_KEY,
    fileName: 'import.xlsx',
    fileSizeBytes: 1024,
    fileContentHash: VALID_HASH,
    createdBy: org.users[0]!.id,
    ...over,
  };
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`Phase6-OrgA-${ts}`, `phase6-orga-${ts}`);
  orgB = await createTestOrg(`Phase6-OrgB-${ts}`, `phase6-orgb-${ts}`);
});

afterAll(async () => {
  // global pool teardown handled elsewhere; nothing per-suite.
});

describe('Phase 6 · import_jobs/import_job_errors — schema invariants', () => {
  it('1) RLS — a row created in Org A is invisible to Org B via withTenant', async () => {
    const inserted = await withTenant(orgA.id, async (tx) =>
      tx.insert(importJobs).values(jobRow(orgA)).returning({ id: importJobs.id }),
    );
    const id = inserted[0]!.id;

    const fromB = await withTenant(orgB.id, async (tx) =>
      tx
        .select({ id: importJobs.id })
        .from(importJobs)
        .where(sql`${importJobs.id} = ${id}`),
    );
    expect(fromB).toHaveLength(0);
  });

  it('2) RLS — withTenant for Org A sees Org A rows, withTenant for Org B sees only Org B rows', async () => {
    const aRow = await withTenant(orgA.id, (tx) =>
      tx.insert(importJobs).values(jobRow(orgA)).returning({ id: importJobs.id }),
    );
    const bRow = await withTenant(orgB.id, (tx) =>
      tx.insert(importJobs).values(jobRow(orgB)).returning({ id: importJobs.id }),
    );

    const aSeen = await withTenant(orgA.id, (tx) =>
      tx.select({ id: importJobs.id }).from(importJobs),
    );
    const bSeen = await withTenant(orgB.id, (tx) =>
      tx.select({ id: importJobs.id }).from(importJobs),
    );

    expect(aSeen.map((r) => r.id)).toContain(aRow[0]!.id);
    expect(aSeen.map((r) => r.id)).not.toContain(bRow[0]!.id);
    expect(bSeen.map((r) => r.id)).toContain(bRow[0]!.id);
    expect(bSeen.map((r) => r.id)).not.toContain(aRow[0]!.id);
  });

  /** Drizzle wraps pg errors as "Failed query: ..." and chains the
   *  original via `.cause`. Helper: walk the cause chain and assert
   *  the underlying pg-error code/message matches what we expect.
   *  This is more robust than regex-matching the wrapped message
   *  (which Drizzle may reformat across versions). */
  async function expectPgError(
    promise: Promise<unknown>,
    expected: { code?: string; constraint?: string; messageMatches?: RegExp },
  ): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }
    expect(caught, 'expected promise to reject').toBeDefined();
    let cur: unknown = caught;
    let depth = 0;
    while (cur && depth < 8) {
      const pg = cur as { code?: string; constraint?: string; message?: string };
      if (expected.code && pg.code === expected.code) return;
      if (expected.constraint && pg.constraint === expected.constraint) return;
      if (
        expected.messageMatches &&
        typeof pg.message === 'string' &&
        expected.messageMatches.test(pg.message)
      ) {
        return;
      }
      cur = (cur as { cause?: unknown })?.cause;
      depth += 1;
    }
    throw new Error(
      `pg error did not match. Looked for ${JSON.stringify(expected)}. ` +
        `Got: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }

  it('3) CHECK — status="invalid" rejected (fail-closed enum)', async () => {
    await expectPgError(
      withTenant(orgA.id, (tx) =>
        tx.insert(importJobs).values(jobRow(orgA, { status: 'invalid' as never })),
      ),
      { code: '23514', constraint: 'import_jobs_status_valid' },
    );
  });

  it('4) CHECK — file_size_bytes=0 rejected (empty file guard)', async () => {
    await expectPgError(
      withTenant(orgA.id, (tx) => tx.insert(importJobs).values(jobRow(orgA, { fileSizeBytes: 0 }))),
      { code: '23514', constraint: 'import_jobs_size_reasonable' },
    );
  });

  it('5) CHECK — file_size_bytes=52428801 (50MB+1) rejected (50MB cap)', async () => {
    await expectPgError(
      withTenant(orgA.id, (tx) =>
        tx.insert(importJobs).values(jobRow(orgA, { fileSizeBytes: 52428801 })),
      ),
      { code: '23514', constraint: 'import_jobs_size_reasonable' },
    );
  });

  it('6) UNIQUE — same (org, idempotency_key) on second insert rejected', async () => {
    const key = `idem-${Date.now()}`;
    await withTenant(orgA.id, (tx) =>
      tx.insert(importJobs).values(jobRow(orgA, { idempotencyKey: key })),
    );
    await expectPgError(
      withTenant(orgA.id, (tx) =>
        tx.insert(importJobs).values(jobRow(orgA, { idempotencyKey: key })),
      ),
      { code: '23505', constraint: 'import_jobs_idem_unique' },
    );
  });

  it('7) UNIQUE — multiple NULL idempotency_key rows allowed (partial index)', async () => {
    const r1 = await withTenant(orgA.id, (tx) =>
      tx
        .insert(importJobs)
        .values(jobRow(orgA, { idempotencyKey: null }))
        .returning({ id: importJobs.id }),
    );
    const r2 = await withTenant(orgA.id, (tx) =>
      tx
        .insert(importJobs)
        .values(jobRow(orgA, { idempotencyKey: null }))
        .returning({ id: importJobs.id }),
    );
    expect(r1[0]!.id).not.toBe(r2[0]!.id);
  });

  it('8) CASCADE — deleting parent import_jobs removes child import_job_errors', async () => {
    // Use provider pool (BYPASSRLS) for DELETE — app_user has no DELETE
    // grant (asserted in test 9). This test models the provider-admin
    // forensic intervention path.
    const inserted = await withTenant(orgA.id, (tx) =>
      tx.insert(importJobs).values(jobRow(orgA)).returning({ id: importJobs.id }),
    );
    const jobId = inserted[0]!.id;

    await withTenant(orgA.id, (tx) =>
      tx.insert(importJobErrors).values({
        jobId,
        orgId: orgA.id,
        rowNumber: 5,
        field: 'national_id',
        code: 'invalid_luhn',
        message: 'תעודת זהות לא תקינה',
      }),
    );

    const before = await withTenant(orgA.id, (tx) =>
      tx
        .select({ id: importJobErrors.id })
        .from(importJobErrors)
        .where(sql`${importJobErrors.jobId} = ${jobId}`),
    );
    expect(before.length).toBeGreaterThanOrEqual(1);

    const provClient = await providerPool.connect();
    try {
      await provClient.query('DELETE FROM import_jobs WHERE id = $1', [jobId]);
    } finally {
      provClient.release();
    }

    const after = await withTenant(orgA.id, (tx) =>
      tx
        .select({ id: importJobErrors.id })
        .from(importJobErrors)
        .where(sql`${importJobErrors.jobId} = ${jobId}`),
    );
    expect(after).toHaveLength(0);
  });

  it('9) GRANT — app_user has no DELETE on import_jobs (forensic guarantee)', async () => {
    // pg code 42501 = insufficient_privilege. Migration 0023 explicitly
    // REVOKEs DELETE to override the default privileges from 0009.
    await expectPgError(
      withTenant(orgA.id, async (tx) => {
        await tx.execute(sql`DELETE FROM import_jobs WHERE id = gen_random_uuid()`);
      }),
      { code: '42501', messageMatches: /permission denied/i },
    );
  });

  it('10) PII — `raw_row` column does NOT exist on import_job_errors (0023 dropped it)', async () => {
    const client = await pool.connect();
    try {
      const res = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'import_job_errors'
             AND column_name = 'raw_row'
         ) AS exists`,
      );
      expect(res.rows[0]?.exists).toBe(false);
    } finally {
      client.release();
    }
  });
});
