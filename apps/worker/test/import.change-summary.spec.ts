/**
 * #6 import "real change-summary" (design §6) — ACCEPTANCE TESTS.
 *
 * INDEPENDENT test-author pass (written FIRST, before the builder).
 * These assert the TARGET behavior and are RED against current code.
 *
 * THE GAP (reproduce-before-fix):
 *   The import PREVIEW (requireConfirm=true → pauses at 'awaiting_confirm'
 *   after validate, NO domain rows written) currently surfaces only ROW
 *   counts (okRows / failedRows on import_jobs). It has NO per-ENTITY
 *   change-summary. So a preview of a sheet with N brand-new owners
 *   reports "0 changes" — the manager can't see what the import WOULD do.
 *
 * THE FIX (spec):
 *   Add `change_summary` jsonb to import_jobs:
 *     { ownersCreated, ownersMatched, apartmentsCreated, buildingsCreated,
 *       ownershipsCreated }
 *   computed during the validate/preview stage as a COUNTING DRY-RUN
 *   (find-or-create counts WITHOUT writing domain rows), persisted on the
 *   row, and surfaced in the status/result DTO + FE.
 *
 *   So a preview of a sheet with N NEW owners must report
 *   ownersCreated = N (not 0); an owner whose national_id ALREADY exists
 *   in the org is counted in ownersMatched, NOT ownersCreated.
 *
 * HARNESS (mirrored from apps/worker/test/persistence.s6.spec.ts):
 *   - FakeStorageProvider holds the xlsx bytes at a server R2 key.
 *   - We INSERT an import_jobs row (requireConfirm=true so the worker
 *     PAUSES at 'awaiting_confirm' after validate — the preview entry
 *     point) pointing at a real project (from createTestOrg) + that key.
 *   - new ImportJobHandler(storage).handle({ jobId, orgId, createdBy })
 *     drives the REAL state machine (parse → validate → pause) against
 *     real Neon. parseStage + validateStage run; persistStage does NOT
 *     (preview pause), so NO buildings/apartments/owners are written.
 *   - We then read change_summary back off the row via the BYPASSRLS
 *     providerPool (raw SQL) so the spec compiles even though the Drizzle
 *     schema has no `change_summary` column YET — the column/field is
 *     exactly what the builder adds. RED now: the column is absent →
 *     the SELECT errors / the field is undefined → ownersCreated !== N.
 *
 *   The DTO axis (#4) drives the API ImportsService.get(...) and asserts
 *   the intended `changeSummary` shape on the wire view. RED now: toView
 *   doesn't carry it.
 *
 * BUILDER INTEGRATION POINTS (where the counting must land):
 *   - apps/worker/src/handlers/import-job.handler.ts validateStage(): after
 *     building `okRows: ValidatedRow[]`, run the find-or-create COUNT
 *     (dedupe owners by national_id_hash, look up existing owners /
 *     buildings / apartments under withTenant WITHOUT inserting) and
 *     persist `change_summary` on the import_jobs row in the SAME UPDATE
 *     that writes processed/ok/failed counters.
 *   - packages/db/src/schema/imports.ts: add the `change_summary` jsonb
 *     column (+ migration).
 *   - packages/shared-types/src/import.ts + imports.service.ts toView():
 *     surface it as `changeSummary` on the wire.
 */
import {
  FakeStorageProvider,
  importJobs,
  owners,
  encryptOwnerPiiBatch,
  withTenant,
} from '@emapp/db';
import { type JobContext } from '@emapp/jobs';
import { eq, sql } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../packages/db/src/client';
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

const HEADERS = ['national_id', 'phone', 'name', 'apartment', 'address', 'ownership_pct'];

/** Luhn-valid Israeli IDs — the exact set the S6 persistence spec uses
 *  (already validated by the existing integration suite). */
const VALID_IDS = ['123456782', '234567899', '345678908', '111111118', '222222226'];

async function buildXlsx(rows: Array<Array<string>>): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Insert a PREVIEW import_jobs row (requireConfirm=true) pointing at a
 *  real project + the given R2 key. The worker PAUSES at
 *  'awaiting_confirm' after validate (no domain writes) — this is the
 *  preview entry point. */
async function createPreviewJob(o: TestOrg, projectId: string, r2Key: string): Promise<string> {
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        projectId,
        fileR2Key: r2Key,
        fileName: 'preview.xlsx',
        fileSizeBytes: 4096,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
        requireConfirm: true,
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

/** Read the change_summary jsonb off the row via the BYPASSRLS pool +
 *  RAW SQL. We deliberately do NOT go through Drizzle's typed columns:
 *  the `change_summary` column does not exist in the schema YET, so a
 *  typed select wouldn't compile. Raw SQL lets this spec compile and
 *  RUN against current code (the SELECT throws "column does not exist"
 *  → caught → returned as null, which is the RED signal).
 *
 *  Returns the parsed jsonb object, or null if the column is absent
 *  (current state) or the value is null. */
async function getChangeSummary(jobId: string): Promise<Record<string, unknown> | null> {
  const c = await providerPool.connect();
  try {
    const res = await c.query<{ change_summary: Record<string, unknown> | null }>(
      `SELECT change_summary FROM import_jobs WHERE id = $1`,
      [jobId],
    );
    return res.rows[0]?.change_summary ?? null;
  } catch {
    // Column does not exist yet (pre-builder). RED state.
    return null;
  } finally {
    c.release();
  }
}

/** Seed an owner into the org directly (encrypted PII) so a later
 *  preview row with the SAME national_id is a MATCH, not a create.
 *  Mirrors resolveOwnersBatch's insert shape. */
async function seedExistingOwner(o: TestOrg, nationalId: string, name: string): Promise<void> {
  await withTenant(
    o.id,
    async (tx) => {
      const [enc] = await encryptOwnerPiiBatch(tx, [{ nationalId, phone: '0500000000', name }]);
      await tx.insert(owners).values({
        orgId: o.id,
        nameEncrypted: enc!.nameEncrypted,
        nameHash: enc!.nameHash,
        nationalIdEncrypted: enc!.nationalIdEncrypted,
        nationalIdHash: enc!.nationalIdHash,
        phoneEncrypted: enc!.phoneEncrypted,
        phoneHash: enc!.phoneHash,
      });
    },
    { userId: o.users[0]!.id },
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`CS-${Date.now()}`, `cs-${Date.now()}`);
});

afterAll(async () => {
  /* pool teardown by vitest workers */
});

describe('#6 import change-summary — preview counting dry-run', () => {
  it('1) preview of N brand-new owners reports ownersCreated = N (RED: change_summary absent)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/cs-1.xlsx`;
    // 3 rows, 3 distinct owners with national_ids NOT already in the org,
    // 3 distinct apartments, 1 building.
    storage.setObject(
      r2Key,
      await buildXlsx([
        [VALID_IDS[0]!, '0501234567', 'Avi', '1', 'Summary St 10', ''],
        [VALID_IDS[1]!, '0521234567', 'Bob', '2', 'Summary St 10', ''],
        [VALID_IDS[2]!, '0531234567', 'Carol', '3', 'Summary St 10', ''],
      ]),
    );
    const jobId = await createPreviewJob(org, projectId, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    // The preview PAUSED — no domain rows persisted.
    const job = await getJob(org, jobId);
    expect(job?.status).toBe('awaiting_confirm');

    // THE CORE ASSERTION. RED now: change_summary column/field is absent
    // → getChangeSummary returns null → ownersCreated is undefined.
    const summary = await getChangeSummary(jobId);
    expect(summary).not.toBeNull();
    expect(summary?.ownersCreated).toBe(3);
  }, 120_000);

  it('2) apartments + buildings counted in the summary', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/cs-2.xlsx`;
    // 2 NEW owners across 2 NEW apartments in ONE new building.
    storage.setObject(
      r2Key,
      await buildXlsx([
        [VALID_IDS[3]!, '0501234567', 'Dana', '10', 'Buildings Ave 5', ''],
        [VALID_IDS[4]!, '0521234567', 'Eli', '11', 'Buildings Ave 5', ''],
      ]),
    );
    const jobId = await createPreviewJob(org, projectId, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const job = await getJob(org, jobId);
    expect(job?.status).toBe('awaiting_confirm');

    const summary = await getChangeSummary(jobId);
    expect(summary).not.toBeNull();
    expect(summary?.apartmentsCreated).toBe(2);
    expect(summary?.buildingsCreated).toBe(1);
    // Ownerships: one per (owner, apartment) row.
    expect(summary?.ownershipsCreated).toBe(2);
  }, 120_000);

  it('3) existing owner is MATCHED not created (no double-count, no overwrite)', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const matchedId = VALID_IDS[0]!; // we will pre-seed this national_id
    const freshId = VALID_IDS[1]!; // this one is new in THIS preview

    // Pre-seed `matchedId` so the preview row with the same id is a MATCH.
    await seedExistingOwner(org, matchedId, 'Pre-Existing');

    const r2Key = `org/${org.id}/import/cs-3.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([
        // Existing owner → ownersMatched.
        [matchedId, '0501234567', 'Pre-Existing', '20', 'Match St 1', ''],
        // Brand-new owner → ownersCreated.
        [freshId, '0521234567', 'Newcomer', '21', 'Match St 1', ''],
      ]),
    );
    const jobId = await createPreviewJob(org, projectId, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const job = await getJob(org, jobId);
    expect(job?.status).toBe('awaiting_confirm');

    const summary = await getChangeSummary(jobId);
    expect(summary).not.toBeNull();
    // The pre-existing owner is matched, NOT created.
    expect(summary?.ownersMatched).toBe(1);
    // Only the genuinely-new owner is counted as created.
    expect(summary?.ownersCreated).toBe(1);
  }, 120_000);

  it('4) preview did NOT write any domain owner rows (counting dry-run, not a real persist)', async () => {
    // Defense-in-depth on the "dry-run" contract: a preview must compute
    // the summary WITHOUT materialising the owners. We re-run scenario #1
    // and assert no NEW owners landed for those national_ids.
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/cs-4.xlsx`;
    // Use IDs unique to this test so the count is unambiguous.
    const idA = VALID_IDS[2]!;
    const idB = VALID_IDS[3]!;
    storage.setObject(
      r2Key,
      await buildXlsx([
        [idA, '0501234567', 'NoWriteA', '30', 'DryRun Summary 1', ''],
        [idB, '0521234567', 'NoWriteB', '31', 'DryRun Summary 1', ''],
      ]),
    );

    const ownersBefore = await withTenant(org.id, async (tx) => {
      const [r] = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(owners)
        .where(eq(owners.orgId, org.id));
      return r?.c ?? 0;
    });

    const jobId = await createPreviewJob(org, projectId, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const job = await getJob(org, jobId);
    expect(job?.status).toBe('awaiting_confirm');

    const ownersAfter = await withTenant(org.id, async (tx) => {
      const [r] = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(owners)
        .where(eq(owners.orgId, org.id));
      return r?.c ?? 0;
    });

    // The preview is a COUNTING dry-run — it must NOT have inserted owners.
    expect(ownersAfter).toBe(ownersBefore);

    // …yet the summary still reports 2 would-be creates.
    const summary = await getChangeSummary(jobId);
    expect(summary).not.toBeNull();
    expect(summary?.ownersCreated).toBe(2);
  }, 120_000);
});
