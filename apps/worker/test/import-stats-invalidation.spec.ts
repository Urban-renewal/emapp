/**
 * E2 Wave-0 PERF freshness — import materialise invalidates the stats cache.
 *
 * THE BUG: the api added a read-through stats cache over
 * `ProjectsService.orgStats` + `signatureProgress`, invalidated by bumping a
 * per-org epoch counter at `stats:epoch:org:<orgId>` at consent-affecting
 * write sites. The owner/apartment IMPORT is materialised by the WORKER's
 * persistStage — it inserts owners/ownerships/apartments (changing
 * orgStats.residents + signatureProgress denominators) but did NOT invalidate.
 * Result: home KPIs + the project board served STALE counts for up to
 * STATS_TTL_SECONDS after an import committed.
 *
 * THE FIX (proved here): persistStage now bumps the SAME epoch counter
 * (shared `@emapp/db` `bumpStatsEpoch`, byte-identical key) AFTER a successful,
 * row-producing materialise — never on dry-run / zero-row imports.
 *
 * Pinned invariants:
 *   1. A row-producing import increments the org's stats epoch, demoting any
 *      previously-warm envelope (stamped at the OLD epoch) to a read-through
 *      MISS → the next read recomputes the fresh post-import count.
 *   2. The invalidation uses the EXACT key the api StatsCacheService reads
 *      (`stats:epoch:org:<orgId>`) — a warm orgStats envelope stamped at the
 *      pre-import epoch is observably stale (its `e` no longer matches).
 *   3. A dry-run import does NOT bump the epoch (no count change → no bust).
 */
import {
  PostgresCacheProvider,
  importJobs,
  statsEpochKey,
  withTenant,
  FakeStorageProvider,
} from '@emapp/db';
import { type JobContext } from '@emapp/jobs';
import { eq } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';

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
/** Luhn-valid Israeli IDs (mirrors persistence.s6.spec.ts). */
const VALID_IDS = ['123456782', '234567899', '345678908'];

async function buildXlsx(rows: Array<Array<string>>): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

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

async function getStatus(o: TestOrg, id: string): Promise<string | undefined> {
  const [row] = await withTenant(o.id, (tx) =>
    tx.select({ status: importJobs.status }).from(importJobs).where(eq(importJobs.id, id)).limit(1),
  );
  return row?.status;
}

/** Read the org's current stats epoch as the api StatsCacheService does
 *  (number value at `stats:epoch:org:<orgId>`; absent ⇒ 0). */
async function currentEpoch(cache: PostgresCacheProvider, orgId: string): Promise<number> {
  const v = await cache.get<number>(statsEpochKey(orgId));
  return typeof v === 'number' ? v : 0;
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  org = await createTestOrg(`IMP-INVAL-${ts}`, `imp-inval-${ts}`);
});

describe('import materialise → stats-cache invalidation (freshness)', () => {
  it('1) a row-producing import bumps the epoch, making a warm envelope a MISS', async () => {
    const cache = new PostgresCacheProvider();
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage, undefined, cache);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/inval-1.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([
        [VALID_IDS[0]!, '0501234567', 'Avi', '1', 'Invalidation St 10', ''],
        [VALID_IDS[1]!, '0521234567', 'Bob', '2', 'Invalidation St 10', ''],
      ]),
    );

    // ── Warm the read-through cache with a STALE count stamped at the
    //    CURRENT epoch (the shape StatsCacheService.readThrough writes/reads:
    //    `stats:org:<orgId>:orgStats:all` → { e: <epoch>, v: <value> }).
    const epochBefore = await currentEpoch(cache, org.id);
    const valueKey = `stats:org:${org.id}:orgStats:all`;
    const STALE_RESIDENTS = 0;
    await cache.set(valueKey, { e: epochBefore, v: { residents: STALE_RESIDENTS } }, 60);

    // Sanity: before the import the warm envelope is a HIT (e matches epoch).
    const warmBefore = await cache.get<{ e: number; v: { residents: number } }>(valueKey);
    expect(warmBefore).not.toBeNull();
    expect(warmBefore!.e).toBe(epochBefore);

    // ── Run the import (materialise 2 owners / 2 apartments).
    const jobId = await createImportJob(org, projectId, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    expect(await getStatus(org, jobId)).toBe('done');

    // ── Invariant 1: the epoch advanced (best-effort bump fired).
    const epochAfter = await currentEpoch(cache, org.id);
    expect(epochAfter).toBe(epochBefore + 1);

    // ── Invariant 2: the warm envelope is now STALE — its stamped epoch no
    //    longer matches the current epoch, so a readThrough treats it as a
    //    MISS (env.e === currentEpoch is false) and would recompute. We model
    //    the readThrough HIT-test exactly: HIT iff env.e === current epoch.
    const warmAfter = await cache.get<{ e: number; v: { residents: number } }>(valueKey);
    expect(warmAfter).not.toBeNull(); // the envelope physically remains (TTL sweep)…
    expect(warmAfter!.e).toBe(epochBefore); // …but stamped at the OLD epoch…
    expect(warmAfter!.e).not.toBe(epochAfter); // …which !== current ⇒ a MISS, not a stale HIT.
  }, 120_000);

  it('2) a dry-run import does NOT bump the epoch (no count change → no bust)', async () => {
    const cache = new PostgresCacheProvider();
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage, undefined, cache);
    const projectId = org.projects[0]!.id;
    const r2Key = `org/${org.id}/import/inval-2-dry.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx([[VALID_IDS[2]!, '0531234567', 'Dry', '9', 'Invalidation St 10', '']]),
    );

    const epochBefore = await currentEpoch(cache, org.id);
    const jobId = await createImportJob(org, projectId, r2Key, true);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    expect(await getStatus(org, jobId)).toBe('done');

    // No domain rows changed ⇒ no needless cache bust.
    const epochAfter = await currentEpoch(cache, org.id);
    expect(epochAfter).toBe(epochBefore);
  }, 120_000);
});
