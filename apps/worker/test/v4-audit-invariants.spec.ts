/**
 * Phase 6 v4 INDEPENDENT audit — comprehensive invariant suite.
 *
 * Three prior audits (v1/v2/v3) closed correctness + security findings.
 * v3 found the P0 A4 data-loss recovery hook that v2's self-review
 * missed. The lesson: spawn INDEPENDENT agents — never self-review.
 *
 * v4 spawned 3 independent agents (SOLID/security/perf) IN PARALLEL.
 * Each found bugs the prior passes missed. This file is the
 * cross-confirmed subset — invariants pinned by code-evidence, with
 * RED tests for verified open bugs and GREEN tests for invariants
 * already enforced that were not previously tested.
 *
 * Test marker conventions (TDD-RED tracking):
 *   - it.fails(): the test asserts the INTENDED post-fix behaviour.
 *     vitest counts it as PASSING because it currently fails. When
 *     the next agent fixes the bug, the test starts PASSING which
 *     causes `it.fails` to FAIL — forcing the next agent to remove
 *     the .fails marker. This is the standard TDD-red-then-green flow.
 *   - it(): green invariant, already enforced, not previously pinned.
 *
 * Axes:
 *   §1 ISO A.18.1.4 — PII creation logging (import.materialised gap)
 *   §2 Forensic observability — attempt number from pg-boss retry
 *   §3 Cancellation race — persistStage / parseStage don't re-check
 *      status mid-flight before transitioning
 *   §4 Worker pickup latency — pg-boss poll cadence
 *   §5 Ownership write batching — per-row INSERT + FOR EACH ROW
 *      deferred trigger is the dominant T6.11 cost driver
 *   §6 Audit metadata integrity — actorId source-of-truth
 *   §7 State machine — terminal state coverage incl. awaiting_mapping
 *
 * Cross-references:
 *   - PROGRESS.md heartbeat (v4 section) — findings ledger
 *   - docs/DECISIONS.html D.34 — layered mapping seam
 *   - docs/07 §12.4 — audit logging spec
 *   - docs/03 §10 — Phase 6 T-IDs (T6.10 perf, T6.11 1000-row)
 */
import { auditLog, importJobs, ownerships, withTenant, FakeStorageProvider } from '@emapp/db';
import { type JobContext } from '@emapp/jobs';
import { and, eq, sql } from 'drizzle-orm';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { ImportJobHandler } from '../src/handlers/import-job.handler';

let org: TestOrg;

function makeCtx(over: Partial<JobContext> = {}): JobContext {
  return {
    jobId: 'pg-boss-v4',
    attempt: 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
    ...over,
  };
}

async function buildXlsx(
  headers: string[],
  rows: ReadonlyArray<ReadonlyArray<string>>,
): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow([...headers]);
  for (const r of rows) ws.addRow([...r]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function createJobRow(o: TestOrg, r2Key: string): Promise<string> {
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        projectId: o.projects[0]!.id,
        fileR2Key: r2Key,
        fileName: 'v4.xlsx',
        fileSizeBytes: 4096,
        fileContentHash: 'sha256:v4',
        createdBy: o.users[0]!.id,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

/** Build a fixture file that materialises N owners under one project.
 *  Uses Luhn-valid Israeli national IDs so validateRow accepts them. */
async function buildHappyPathXlsx(rowCount: number): Promise<Buffer> {
  const rows: string[][] = [];
  // Luhn-valid 9-digit IDs (programmatically — base + Luhn check digit).
  const luhnDigit = (digits8: string): string => {
    let sum = 0;
    for (let i = 0; i < 8; i += 1) {
      const d = parseInt(digits8[i]!, 10) * (i % 2 === 0 ? 1 : 2);
      sum += d > 9 ? d - 9 : d;
    }
    const check = (10 - (sum % 10)) % 10;
    return `${digits8}${check}`;
  };
  for (let i = 0; i < rowCount; i += 1) {
    const base = String(100000000 + i).slice(0, 8);
    const id = luhnDigit(base);
    rows.push([id, '0501234567', `Avi${i}`, String(i + 1), 'Herzl 10']);
  }
  return buildXlsx(['national_id', 'phone', 'name', 'apartment', 'address'], rows);
}

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`V4-${Date.now()}`, `v4-${Date.now()}`);
});

afterAll(async () => {
  /* pool teardown */
});

describe('Phase 6 v4 audit · §1 — ISO A.18.1.4 PII creation logging', () => {
  // ISO 27001 A.18.1.4 mandates that PII data CREATION events are
  // auditable. The handler writes per-state transitions
  // (parsing/validating/persisting/done) — but the regulator's
  // question is "how many PII records were created on date X for org
  // Y?". That requires an aggregate row at the materialisation
  // boundary, NOT per-state-transition rows that say nothing about
  // PII counts.
  //
  // v3 audit-pass claimed D1 closed. v4 grep shows zero hits for
  // 'import.materialised' in apps/worker/src. The audit row does NOT
  // exist. False-closure recorded in PROGRESS.md heartbeat v4 section.
  it('1) happy-path import writes an `import.materialised` audit row carrying ok_rows count', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/v4-mat.xlsx`;
    storage.setObject(r2Key, await buildHappyPathXlsx(3));
    const jobId = await createJobRow(org, r2Key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const rows = await withTenant(org.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
    );
    const materialised = rows.find((r) => r.action === 'import.materialised');
    expect(materialised, 'expected import.materialised audit row to exist').toBeDefined();
    expect(materialised!.metadata).toMatchObject({
      // The aggregate-count fields are what the regulator queries.
      ok_rows: expect.any(String),
      apartment_count: expect.any(String),
    });
    // No PII surface — scan ONLY the metadata jsonb (not the full
    // row, which includes UUIDs that may contain 9+ consecutive
    // digits by chance — those are not PII).
    const metaBlob = JSON.stringify(materialised!.metadata);
    expect(metaBlob).not.toMatch(/\d{9}/); // no 9-digit national_id
    expect(metaBlob).not.toMatch(/05\d{8}/); // no Israeli mobile phone
  }, 90_000);

  it('1b) every PII-creating row has at least one audit_log entry with target_id=jobId', async () => {
    // This is the WEAKER invariant the v3 D1 closure actually
    // delivered. It IS true (parsing/validating/persisting/done all
    // write rows) — we pin it so a future refactor doesn't lose it.
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/v4-mat-1b.xlsx`;
    storage.setObject(r2Key, await buildHappyPathXlsx(2));
    const jobId = await createJobRow(org, r2Key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const rows = await withTenant(org.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
    );
    // received + parsing + validating + persisting + done = 5 minimum
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});

describe('Phase 6 v4 audit · §2 — Forensic observability (retry attempt)', () => {
  // pg-boss-adapter.ts:113 hardcodes `attempt = 1`. The audit row
  // metadata writes `attempt: String(ctx.attempt)` (handler line 504).
  // Every audit row therefore says attempt='1' — an SRE diagnosing a
  // thrashing job CANNOT distinguish attempt 1 from attempt 5. Breaks
  // the per-attempt forensic story the handler JSDoc claims.
  //
  // The fix needs `includeMetadata: true` + plumb `job.retryCount`
  // through the adapter to `ctx.attempt`. This is an adapter-side
  // test — the handler itself is correct in passing ctx.attempt
  // through. We pin the EXPECTATION from the user's POV: a synthetic
  // ctx with attempt=3 must produce audit rows tagged attempt='3'.
  it('2) ctx.attempt is faithfully written to audit_log.metadata.attempt', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/v4-attempt.xlsx`;
    storage.setObject(r2Key, await buildHappyPathXlsx(1));
    const jobId = await createJobRow(org, r2Key);

    await handler.handle(
      { jobId, orgId: org.id, createdBy: org.users[0]!.id },
      makeCtx({ attempt: 3 }),
    );

    const rows = await withTenant(org.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
    );
    const received = rows.find((r) => r.action === 'import.received');
    expect(received).toBeDefined();
    expect(received!.metadata).toMatchObject({ attempt: '3' });
  });

  // The adapter-side bug — assert via direct read that the adapter
  // does NOT hardcode attempt. This is a static-shape test: we
  // expect the source to call `boss.work` with `includeMetadata:
  // true`. Read-only; no DB.
  it('2b) pg-boss adapter requests includeMetadata=true so retryCount is observable', async () => {
    // Static-shape assertion via re-import + introspection. The
    // adapter currently passes `includeMetadata: false` (v4 grep).
    const adapterSource = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/pg-boss-adapter.ts', import.meta.url), 'utf8');
    // Look for a configuration line that enables metadata.
    expect(adapterSource).toMatch(/includeMetadata:\s*true/);
  });
});

describe('Phase 6 v4 audit · §3 — Cancellation race', () => {
  // FORWARD['cancelled'] === null so a job already cancelled is
  // terminal — the loop exits. GREEN.
  it('3) `cancelled` is a terminal state in the FORWARD table (loop exits cleanly)', async () => {
    const r2Key = `org/${org.id}/import/v4-cancel-noop.xlsx`;
    const jobId = await createJobRow(org, r2Key);
    // Manually flip to 'cancelled' BEFORE handler.handle runs.
    await withTenant(org.id, async (tx) =>
      tx.update(importJobs).set({ status: 'cancelled' }).where(eq(importJobs.id, jobId)),
    );

    const handler = new ImportJobHandler();
    // Should NOT throw — terminal state is a clean idempotent exit.
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const [row] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1),
    );
    expect(row?.status).toBe('cancelled');
  });

  // The persistStage tx (handler.ts:1203-1271) does NOT re-check
  // status mid-tx. A Manager who hits cancel after parseStage has
  // committed but before persistStage commits gets full data
  // materialised regardless. RED — needs a status guard inside
  // persistStage (e.g. final UPDATE with WHERE status != 'cancelled').
  it('3b) persistStage aborts if status becomes `cancelled` before its UPDATE commits', async () => {
    // This invariant is impossible to test deterministically
    // without mid-tx injection. We assert the WEAKER static
    // contract: persistStage's final touch UPDATE includes a
    // status guard. Read-only source inspection.
    const handlerSource = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/handlers/import-job.handler.ts', import.meta.url), 'utf8');
    // Look for the persistStage final UPDATE (currently line ~1265).
    // The guarded form should include WHERE status != 'cancelled'
    // or similar protective clause.
    const persistStageBlock = handlerSource.slice(
      handlerSource.indexOf('private async persistStage'),
      handlerSource.indexOf('private async markFailed'),
    );
    expect(persistStageBlock, 'persistStage must check cancellation before committing').toMatch(
      /status.*!=.*cancelled|status.*<>.*cancelled|ne\(importJobs\.status,\s*['"]cancelled['"]\)/i,
    );
  });

  // The parseStage awaiting_mapping UPDATE at handler.ts:763-789 has
  // no `WHERE status = 'parsing'` guard. If a cancel races with
  // parseStage hitting Layer-1 miss, awaiting_mapping resurrects the
  // cancelled row. RED — needs the same guard the main runStage uses.
  it('3c) parseStage awaiting_mapping UPDATE is guarded by current status=parsing', async () => {
    const handlerSource = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/handlers/import-job.handler.ts', import.meta.url), 'utf8');
    // Find the awaiting_mapping path and assert it has a status guard.
    // v6 audit follow-up: window widened from 1500 -> 3000 chars
    // because v6 added inline comments + parsed_headers sanitisation
    // in the SET block, pushing the WHERE clause further down.
    const awaitingBlock = handlerSource.slice(
      handlerSource.indexOf("status: 'awaiting_mapping'"),
      handlerSource.indexOf("status: 'awaiting_mapping'") + 3000,
    );
    expect(awaitingBlock).toMatch(/eq\(importJobs\.status,\s*['"]parsing['"]\)/);
  });
});

describe('Phase 6 v4 audit · §4 — Worker pickup latency', () => {
  // pg-boss v10 default `newJobCheckInterval` is 2000ms. apps/worker/
  // src/main.ts does NOT override it. Every customer waits ~2s after
  // upload before the worker even reads the queue. "If a customer
  // waits we've lost them" (Lidor verbatim) — this is the literal
  // first 2s of wait time, easy fix.
  it('4) pg-boss worker is configured with newJobCheckInterval <= 500ms', async () => {
    // pg-boss v10 takes newJobCheckInterval as a `work()`-side option
    // (per-worker), not a constructor option. The adapter is the
    // single source of truth for worker config.
    const adapterSource = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/pg-boss-adapter.ts', import.meta.url), 'utf8');
    const match = adapterSource.match(/newJobCheckInterval:\s*(\d+)/);
    expect(match, 'boss.work({...}) must configure newJobCheckInterval').not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(500);
  });
});

describe('Phase 6 v4 audit · §5 — Ownership write batching (T6.11 dominant cost)', () => {
  // handler.ts:1255-1261 — per-row tx.insert(ownerships) loop.
  // For 1000 rows that's 1000 sequential round-trips. Combined with
  // migration 0002's `FOR EACH ROW` DEFERRED trigger
  // trg_ownerships_sum_check, COMMIT fires N additional SUM queries.
  // Result: T6.11 (1000 rows) measures ~400s — fails the implicit
  // "reasonable for production" expectation.
  //
  // Cross-confirmed by both Agent A H-5 and Agent C P0-1.
  it('5) ownership inserts in persistStage are batched (single tx.insert(ownerships).values([...])) ', async () => {
    const handlerSource = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/handlers/import-job.handler.ts', import.meta.url), 'utf8');
    // STEP D currently has `for (const o of ownersForApt)` with
    // an inline tx.insert per iteration. After the fix it should
    // collect rows + one bulk insert.
    const stepDStart = handlerSource.indexOf('STEP D');
    const stepDBlock = handlerSource.slice(stepDStart, stepDStart + 2500);
    // Heuristic: the fix collapses the per-row insert loop. The
    // post-fix code should NOT have a literal `for (const o of
    // ownersForApt)` containing `await tx.insert(ownerships)`.
    const hasPerRowInsert =
      /for\s*\(\s*const\s+o\s+of\s+ownersForApt\s*\)\s*\{[\s\S]*?await\s+tx\.insert\(ownerships\)/.test(
        stepDBlock,
      );
    expect(hasPerRowInsert, 'STEP D must NOT contain a per-row tx.insert(ownerships) loop').toBe(
      false,
    );
  });

  // The deferred trigger fires per-row at COMMIT — 1000 rows means
  // 1000 SUM queries at the COMMIT phase. Migration 0002 declares
  // `FOR EACH ROW`. For the post-fix world a follow-up migration
  // converts it to `FOR EACH STATEMENT` with a transition table.
  // The trigger lives in @emapp/db migrations — this static check
  // pins the expectation so v5 doesn't forget.
  it('5b) trigger_check_ownership_sum memoizes per-tx so N row-fires → M unique-apartment SUM queries', async () => {
    // PostgreSQL CONSTRAINT TRIGGERs MUST be FOR EACH ROW (documented
    // limitation — REFERENCING transition tables are only for
    // non-constraint triggers). The perf win comes from inside the
    // trigger FUNCTION: a per-tx memo via a temp table short-circuits
    // redundant SUM checks for the same apartment.
    const client = await providerPool.connect();
    try {
      const res = await client.query<{ src: string }>(
        `SELECT prosrc AS src FROM pg_proc WHERE proname = 'trigger_check_ownership_sum'`,
      );
      expect(res.rows[0]?.src).toBeDefined();
      const src = res.rows[0]!.src;
      // Memoization pattern from migration 0030: temp table named
      // `_ownership_sum_checked` + ON CONFLICT DO NOTHING gate.
      expect(src, 'function must use a per-tx memo temp table').toMatch(/_ownership_sum_checked/);
      expect(src, 'memo must use ON COMMIT DROP for natural tx-scope').toMatch(/ON COMMIT DROP/i);
      expect(src, 'memo gate must use ON CONFLICT DO NOTHING short-circuit').toMatch(
        /ON CONFLICT DO NOTHING/i,
      );
    } finally {
      client.release();
    }
  });

  // GREEN — ownership SUM invariant still holds (D.25). Pinned so
  // any FOR EACH STATEMENT migration cannot regress correctness.
  it('5c) per-apartment ownership_pct still sums to 100 after happy-path import', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/v4-sum.xlsx`;
    storage.setObject(r2Key, await buildHappyPathXlsx(2));
    const jobId = await createJobRow(org, r2Key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    // Each apartment created by the fixture has exactly one owner
    // → active ownership_pct should be 100. Filter ended_at IS NULL
    // because prior tests in this file may have created ENDED rows
    // for the same apartments (set-replace semantics, D.25).
    const rows = await withTenant(org.id, (tx) =>
      tx
        .select({ pct: ownerships.ownershipPct, apt: ownerships.apartmentId })
        .from(ownerships)
        .where(sql`${ownerships.endedAt} IS NULL`),
    );
    expect(rows.length).toBeGreaterThan(0);
    // SUM per apartment must be 100 (after the deferred trigger
    // passed at COMMIT, this is a re-assertion at the app layer).
    const sums = new Map<string, number>();
    for (const r of rows) {
      sums.set(r.apt, (sums.get(r.apt) ?? 0) + Number(r.pct));
    }
    for (const total of sums.values()) {
      expect(total).toBe(100);
    }
  });
}, 60_000);

describe('Phase 6 v4 audit · §6 — Audit metadata integrity', () => {
  // handler.ts:499 — audit_log.actor_id = payload.createdBy. The
  // payload is Zod-validated at the adapter but not HMAC-signed.
  // The S8 POST /imports endpoint (NOT YET BUILT) must enforce
  // createdBy === req.user.sub. Pre-S8 we pin the WEAKER
  // invariant: actor_id MUST match import_jobs.created_by from the
  // DB row, not from the payload (defense in depth).
  it('6) audit_log.actor_id is derived from import_jobs.created_by (DB) not payload.createdBy', async () => {
    const handlerSource = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/handlers/import-job.handler.ts', import.meta.url), 'utf8');
    // Post-fix shape: actorId fetched alongside the status read.
    // Heuristic: the AuditService.log call should NOT take
    // `actorId: payload.createdBy` directly — instead, a
    // db-fetched user id.
    const auditCalls = handlerSource.match(/actorId:\s*payload\.createdBy/g) ?? [];
    // After the fix, zero direct uses of payload.createdBy as
    // actorId — all should go through a verified DB lookup.
    expect(auditCalls.length).toBe(0);
  });

  // GREEN — every audit row across a successful import has
  // actor_type='system'. This is enforced + already tested
  // elsewhere; re-pinned here as part of the v4 ledger.
  it('6b) all audit rows in a successful import carry actor_type=system', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/v4-actor.xlsx`;
    storage.setObject(r2Key, await buildHappyPathXlsx(1));
    const jobId = await createJobRow(org, r2Key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const rows = await withTenant(org.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.actorType).toBe('system');
    }
  }, 60_000);

  // GREEN — audit metadata contains NO PII surface across all
  // transitions. Re-pin from audit-no-pii.spec.ts perspective.
  it('6c) audit metadata across all transitions contains no national_id / phone substrings', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/v4-pii.xlsx`;
    storage.setObject(r2Key, await buildHappyPathXlsx(2));
    const jobId = await createJobRow(org, r2Key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    const rows = await withTenant(org.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId))),
    );
    // Scan ONLY metadata fields — the row-level UUIDs (id, orgId,
    // targetId, actorId) contain digits randomly and would
    // false-positive on a 9-digit-run regex despite carrying no PII.
    const metaBlob = JSON.stringify(rows.map((r) => r.metadata));
    expect(metaBlob).not.toMatch(/\d{9}/); // no national_id
    expect(metaBlob).not.toMatch(/05\d{8}/); // no Israeli mobile
  }, 60_000);
});

describe('Phase 6 v4 audit · §7 — State machine terminal coverage', () => {
  // GREEN — the FORWARD table covers every status, treats terminals
  // as null, and accepts awaiting_mapping (D.34). Pin via DB CHECK
  // constraint readback (single source of truth for the enum).
  it('7) import_jobs.status CHECK accepts all 8 states incl. awaiting_mapping', async () => {
    const client = await providerPool.connect();
    try {
      const res = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'import_jobs_status_valid'`,
      );
      expect(res.rows[0]?.def).toBeDefined();
      for (const s of [
        'queued',
        'parsing',
        'validating',
        'persisting',
        'done',
        'failed',
        'cancelled',
        'awaiting_mapping',
      ]) {
        expect(res.rows[0]!.def).toContain(s);
      }
    } finally {
      client.release();
    }
  });

  // GREEN — cross-org RLS holds for awaiting_mapping rows
  // specifically (new state introduced in S7).
  it('7b) awaiting_mapping rows are invisible across org boundaries (RLS)', async () => {
    const otherOrg = await createTestOrg(`V4O-${Date.now()}`, `v4o-${Date.now()}`);
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/v4-am-rls.xlsx`;
    storage.setObject(
      r2Key,
      await buildXlsx(
        // Headers that don't match any Layer-1 alias → awaiting_mapping.
        ['mystery_a', 'mystery_b', 'mystery_c', 'mystery_d', 'mystery_e'],
        [['1', '2', '3', '4', '5']],
      ),
    );
    const jobId = await createJobRow(org, r2Key);
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());

    // Verify state from owner's org first.
    const [self] = await withTenant(org.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1),
    );
    expect(self?.status).toBe('awaiting_mapping');

    // Other-org tenant must see zero rows for the same id.
    const fromOther = await withTenant(otherOrg.id, (tx) =>
      tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1),
    );
    expect(fromOther).toHaveLength(0);
  }, 60_000);

  // GREEN — terminal state idempotency: a second handle() invocation
  // on a `done` row writes zero new audit rows and zero state
  // changes (already tested elsewhere but worth re-asserting from
  // this suite's angle).
  it('7c) terminal-state idempotency: second handle() on `done` is a no-op', async () => {
    const storage = new FakeStorageProvider();
    const handler = new ImportJobHandler(storage);
    const r2Key = `org/${org.id}/import/v4-idem.xlsx`;
    storage.setObject(r2Key, await buildHappyPathXlsx(1));
    const jobId = await createJobRow(org, r2Key);

    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const beforeCount = await withTenant(org.id, async (tx) => {
      const r = await tx
        .select({ c: sql<string>`count(*)` })
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId)));
      return Number(r[0]!.c);
    });

    // Re-run.
    await handler.handle({ jobId, orgId: org.id, createdBy: org.users[0]!.id }, makeCtx());
    const afterCount = await withTenant(org.id, async (tx) => {
      const r = await tx
        .select({ c: sql<string>`count(*)` })
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, jobId)));
      return Number(r[0]!.c);
    });
    // The only legitimate increment is one fresh import.received
    // audit row (per-attempt, by design — C5 invariant). NO
    // transition rows should re-fire.
    expect(afterCount - beforeCount).toBeLessThanOrEqual(1);
  }, 90_000);
});
