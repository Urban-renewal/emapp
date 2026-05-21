/**
 * Test #10 — T6.10 perf baseline (docs/03 §10 line 2173:
 *   "ייבוא 100 שורות < 45 שניות ב-Free Tier")
 *
 * This is the explicit phase-exit criterion for Phase 6. Until this
 * spec landed there was NO automated measurement — we were flying
 * blind on the most important number in the phase.
 *
 * Method: end-to-end timing of one `handler.handle()` call over a
 * 100-row valid xlsx fixture, with the FakeStorageProvider serving
 * the file in-memory. Real cost components measured:
 *   - 50MB → 5KB xlsx decompression (ExcelJS)
 *   - parseExcelFull row iteration (100 rows × 5 cols)
 *   - resolveMapping (pure)
 *   - 100x validateRow (Luhn + phone regex + dedup set)
 *   - withTenant DB round-trips (state transitions + audit + counter
 *     write + error batch insert when applicable)
 *
 * NOT measured here (deliberately): R2 network egress, pg-boss
 * scheduling latency, FE polling overhead. Test #4 covers the
 * pg-boss path. Real-prod R2 will add a fixed ~500ms one-shot read;
 * that's still well under budget.
 *
 * Budget: docs spec is 45s on Free Tier. Local Neon (with paid
 * developer cap) is roughly 1.5-2x faster than Free Tier; we set
 * the local cap at 22s to leave a 2x margin while still failing
 * the test if a regression doubles the wall time.
 *
 * Pinned invariant:
 *   1. 100 valid rows process to import_jobs.status='done' in <22s
 */
import { FakeStorageProvider, importJobs, withTenant } from '@emapp/db';
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
    jobId: 'perf-test',
    attempt: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  };
}

/** 100 unique Luhn-valid Israeli IDs generated programmatically. */
function generate100ValidIds(): string[] {
  // For a 9-digit ID d1..d9 where d9 is the check digit:
  // sum(d_i * (i odd ? 2 : 1) [mod-9-cap]) ≡ 0 (mod 10).
  // We construct ids systematically: vary the 8-digit prefix, compute
  // the check digit.
  const ids: string[] = [];
  // n is the 8-digit prefix (10000001..99999999 range). String(n)
  // for n ≥ 10000000 is already 8 chars; padStart is a defensive
  // no-op for smaller values that won't appear here.
  for (let n = 10000001; ids.length < 100; n += 7) {
    const eight = String(n).padStart(8, '0');
    // Sum d1..d8 with alternating doubling, then determine d9 = (10 - sum%10) % 10.
    let sum = 0;
    for (let i = 0; i < 8; i += 1) {
      let d = Number(eight[i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    const check = (10 - (sum % 10)) % 10;
    ids.push(eight + String(check));
  }
  return ids;
}

async function build100RowXlsx(): Promise<Buffer> {
  const ids = generate100ValidIds();
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['national_id', 'phone', 'name', 'apartment', 'address']);
  for (let i = 0; i < 100; i += 1) {
    ws.addRow([ids[i], '0501234567', `Owner ${i}`, String(i + 1), 'Herzl 10']);
  }
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
        fileSizeBytes: 32_000,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`PERF-${Date.now()}`, `perf-${Date.now()}`);
});

afterAll(async () => {
  /* pool teardown by vitest workers */
});

const T6_10_LOCAL_BUDGET_MS = 22_000; // 22s local; spec is 45s Free Tier

describe('Test #10 — T6.10 perf baseline (100 rows < 45s Free Tier)', () => {
  it(`1) 100 valid rows complete in <${T6_10_LOCAL_BUDGET_MS}ms`, async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/perf-100.xlsx`;
    storage.setObject(r2Key, await build100RowXlsx());
    const jobId = await createJob(org, r2Key);

    const start = Date.now();
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const elapsed = Date.now() - start;

    const [row] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1),
    );
    expect(row?.status).toBe('done');
    expect(row?.processedRows).toBe(100);
    expect(row?.okRows).toBe(100);
    expect(row?.failedRows).toBe(0);

    // The actual ASSERTION — if a regression pushes wall time past
    // the local budget, this fires loudly.
    // eslint-disable-next-line no-console
    console.log(
      `T6.10 perf: 100 valid rows processed in ${elapsed}ms (local budget ${T6_10_LOCAL_BUDGET_MS}ms; spec 45000ms Free Tier)`,
    );
    expect(elapsed).toBeLessThan(T6_10_LOCAL_BUDGET_MS);
  }, 60_000); // per-test timeout 60s — even on a bad Neon day this should resolve
});
