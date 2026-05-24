/**
 * T6.11 — 1000-row perf baseline (docs/03 §10 — the final Phase 6 DoD
 * T-ID). Mirror of T6.10 but at 10x the row count.
 *
 * Why this test landed AFTER v4 closure: pre-v4 the 1000-row path
 * measured ~400s — well over any reasonable production budget —
 * because (a) `persistStage` looped per-row `tx.insert(ownerships)`
 * causing 1000 sequential round-trips, and (b) the FOR EACH ROW
 * DEFERRED ownership-sum trigger fired 1000 times at COMMIT, each
 * running a full SUM scan. v4 fixed both: bulk INSERT per
 * apartment-group + per-tx memoization in the trigger function
 * (migration 0030).
 *
 * Spec posture (docs/03 §10): the 100-row test (T6.10) ships a 45s
 * Free-Tier budget. T6.11 is "1000 rows in a reasonable time" —
 * docs don't pin a number, but a production-grade upload pipeline
 * shouldn't take more than ~30s on Free Tier for 1000 rows; on local
 * Neon (paid developer plan, ~2x faster on writes) we set a 90s
 * local budget to leave a margin while still failing loudly on a
 * regression that doubles wall time.
 *
 * Fixture design: 500 unique apartments × 2 owners each = 1000 rows.
 * This exercises BOTH v4 perf fixes simultaneously:
 *   - bulk INSERT (collapsing the per-row ownership insert loop)
 *   - memoized SUM trigger (each apartment is visited twice; the
 *     memo short-circuits the second fire's SUM scan)
 * Pre-v4 fixture analysis: ~400s. Post-v4 expectation: 30-60s on
 * Neon, well under the 90s local budget.
 *
 * Pinned invariants:
 *   1. 1000 rows process to status='done' under the local budget
 *   2. okRows = 1000 (all valid Luhn + phone + Hebrew name pass)
 *   3. apartments materialised = 500; ownership rows = 1000
 *   4. SUM(ownership_pct) = 100 per apartment (D.25 + trigger invariant)
 */
import { FakeStorageProvider, apartments, importJobs, ownerships, withTenant } from '@emapp/db';
import { type JobContext } from '@emapp/jobs';
import { eq, sql } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';

let org: TestOrg;

function makeCtx(): JobContext {
  return {
    jobId: 'perf-t6.11',
    attempt: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  };
}

/** Generate N unique Luhn-valid Israeli IDs. Same algorithm as T6.10
 *  but parameterised by count + an offset so the IDs are stable across
 *  test runs (no clash with T6.10's set since the perf orgs differ). */
function generateValidIds(count: number, offset = 0): string[] {
  const ids: string[] = [];
  for (let n = 20_000_001 + offset * 7; ids.length < count; n += 7) {
    const eight = String(n).padStart(8, '0');
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

/** 500 unique apartments × 2 owners each = 1000 rows with 50/50
 *  ownership splits. The fixture deliberately stresses BOTH v4 perf
 *  fixes (bulk insert + memoized SUM trigger). */
async function build1000RowXlsx(): Promise<Buffer> {
  const ids = generateValidIds(1000);
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['national_id', 'phone', 'name', 'apartment', 'address', 'ownership_pct']);
  for (let i = 0; i < 1000; i += 1) {
    const aptNumber = String(Math.floor(i / 2) + 1); // 2 rows per apt -> 500 apts
    ws.addRow([ids[i], '0501234567', `Owner ${i}`, aptNumber, 'Herzl 10', '50']);
  }
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
        fileName: 'import-1000.xlsx',
        fileSizeBytes: 320_000,
        fileContentHash: 'sha256:t6_11',
        createdBy: o.users[0]!.id,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`PERF11-${Date.now()}`, `perf11-${Date.now()}`);
});

afterAll(async () => {
  /* pool teardown */
});

/** Local budget — generous to stay green on shared-CI runs over
 *  occasional Neon latency spikes, but tight enough that any
 *  regression to the pre-v4 ~400s posture would fire loudly. */
const T6_11_LOCAL_BUDGET_MS = 90_000;

describe('Test #11 — T6.11 perf (1000 rows under budget)', () => {
  it(`1) 1000 valid rows (500 apts × 2 owners) complete in <${T6_11_LOCAL_BUDGET_MS}ms`, async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/perf-1000.xlsx`;
    storage.setObject(r2Key, await build1000RowXlsx());
    const jobId = await createJob(org, r2Key);

    const start = Date.now();
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const elapsed = Date.now() - start;

    const [row] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1),
    );
    expect(row?.status).toBe('done');
    expect(row?.processedRows).toBe(1000);
    expect(row?.okRows).toBe(1000);
    expect(row?.failedRows).toBe(0);

    // Domain invariants — make sure the perf gains didn't sacrifice
    // correctness (the whole point of v4's memo trigger + bulk INSERT
    // is that they're observationally equivalent to the prior
    // per-row trigger + per-row insert).
    const aptCount = await withTenant(org.id, async (tx) => {
      const r = await tx.select({ c: sql<string>`count(*)` }).from(apartments);
      return Number(r[0]!.c);
    });
    expect(aptCount).toBe(500);

    const ownershipRows = await withTenant(org.id, async (tx) => {
      const r = await tx
        .select({ apt: ownerships.apartmentId, pct: ownerships.ownershipPct })
        .from(ownerships)
        .where(sql`${ownerships.endedAt} IS NULL`);
      return r;
    });
    expect(ownershipRows.length).toBe(1000);

    // SUM = 100 per apartment (D.25 + ownership-sum trigger invariant).
    // This is what the deferred constraint trigger enforces at COMMIT;
    // re-asserting it from the app layer ensures the memoization fix
    // didn't accidentally skip a check.
    const sums = new Map<string, number>();
    for (const r of ownershipRows) {
      sums.set(r.apt, (sums.get(r.apt) ?? 0) + Number(r.pct));
    }
    expect(sums.size).toBe(500);
    for (const total of sums.values()) {
      expect(total).toBe(100);
    }

    // eslint-disable-next-line no-console
    console.log(
      `T6.11 perf: 1000 valid rows (500 apts × 2 owners) processed in ${elapsed}ms ` +
        `(local budget ${T6_11_LOCAL_BUDGET_MS}ms; pre-v4 measured ~400000ms)`,
    );
    expect(elapsed).toBeLessThan(T6_11_LOCAL_BUDGET_MS);
  }, 180_000);
});
