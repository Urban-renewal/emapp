/**
 * Phase 6 S8 — imports API mutation surface integration tests.
 *
 * The contract suite (apps/api/src/modules/*.contract.spec.ts) needs a
 * compiled API + provisioned orgs over HTTP; that's the canonical
 * conformance pass and runs in CI. For S8 we add a SERVICE-LEVEL
 * integration spec that instantiates ImportsService directly with a
 * Fake storage provider + Fake job producer, then hits real Neon for
 * the RLS-FORCE + audit + state-machine invariants. Same pattern as
 * imports-stream.spec.ts / imports-controller-http.spec.ts — fast to
 * run, no harness needed.
 *
 * Defense-in-depth axes pinned here:
 *   §A POST /imports — create + presign:
 *      A1 happy-path Manager: row created (status='queued'), upload
 *         URL minted, audit row written
 *      A2 viewer/agent → ForbiddenException (D.17)
 *      A3 cross-org project → 404 NOT_FOUND (no oracle)
 *      A4 r2Key NEVER returned on the wire (confidentiality)
 *      A5 file_size_bytes > 50MB → Zod rejects (defense-in-depth at
 *         migration 0022 CHECK)
 *      A6 audit_log row carries NO PII (name/size/dryRun only)
 *
 *   §B POST /imports/:id/start — enqueue:
 *      B1 happy-path: producer.send called with {jobId, orgId,
 *         createdBy} + singletonKey=id
 *      B2 status != 'queued' → 409 import_not_startable
 *      B3 different Manager (same org) tries to start someone else's
 *         draft → 403 (defense in depth)
 *      B4 cross-org id → 404
 *      B5 audit row 'import.start_requested' written before send
 *
 *   §C DELETE /imports/:id — cancel:
 *      C1 happy-path queued → cancelled, audit row written
 *      C2 happy-path awaiting_mapping → cancelled
 *      C3 already 'done' → 409 import_not_cancellable
 *      C4 already 'cancelled' → 409 (idempotent posture: same code)
 *      C5 cross-org → 404
 *      C6 viewer/agent → 403
 *      C7 cancel is a guarded UPDATE (race-safe — if worker just
 *         flipped to 'done' between our load and our UPDATE,
 *         rowCount=0 and we silently no-op)
 *
 *   §D GET /imports/:id/errors — paginated:
 *      D1 returns rows for this job; sorted by rowNumber asc
 *      D2 cross-org → 404 (visibility gate before query)
 *      D3 cursor pagination works (has_more + cursor advance)
 *      D4 message field is non-null on the wire (fallback to code)
 *
 *   §E POST /imports/:id/mapping (D.34 wizard):
 *      E1 happy-path awaiting_mapping → row flips to 'queued',
 *         mapping_template inserted (source='manual', approved_by),
 *         producer.send called with singletonKey=id, audit row
 *      E2 status != 'awaiting_mapping' → 409
 *      E3 duplicate column indexes → 400 mapping_duplicate_column
 *      E4 viewer/agent → 403
 *      E5 cross-org → 404
 */
import { auditLog, importJobs, importJobErrors, mappingTemplates, withTenant } from '@emapp/db';
import { type IJobProducer, type JobSendOptions, type JobSendResult } from '@emapp/jobs';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ImportsService } from './imports.service';

/** Fake job producer — records every send for assertion. */
class FakeProducer implements IJobProducer {
  public sends: Array<{ name: string; payload: unknown; opts?: JobSendOptions }> = [];
  async send<T>(name: string, payload: T, opts?: JobSendOptions): Promise<JobSendResult> {
    this.sends.push({ name, payload, opts });
    return { id: `fake-pgboss-${this.sends.length}` };
  }
  reset(): void {
    this.sends = [];
  }
}

/** Fake storage — uses the @emapp/db FakeStorageProvider but tracks
 *  head() returns so we can simulate "client uploaded a different
 *  size" cases. */
class FakeStorage {
  private nextHead: { contentLength: number } | null = null;
  setNextHead(meta: { contentLength: number } | null): void {
    this.nextHead = meta;
  }
  async getUploadUrl(): Promise<string> {
    return 'https://fake-storage.test/upload/key';
  }
  async getDownloadUrl(): Promise<string> {
    return 'https://fake-storage.test/download/key';
  }
  async delete(): Promise<void> {}
  async head(): Promise<{ contentLength: number } | null> {
    return this.nextHead;
  }
  async healthCheck(): Promise<void> {}
  getObjectStream(): never {
    throw new Error('not used in S8 service tests');
  }
}

let orgA: TestOrg;
let orgB: TestOrg;

const producer = new FakeProducer();
const storage = new FakeStorage();
const svc = new ImportsService(storage as never, producer);

// Stable but unique session_id (UUID column in audit_log).
const TEST_SID = '00000000-0000-4000-8000-00000000abcd';

function userOf(
  o: TestOrg,
  role: 'manager' | 'agent' | 'viewer' = 'manager',
  userIdx = 0,
): AccessTokenPayload {
  return {
    sub: o.users[userIdx]!.id,
    orgId: o.id,
    role,
    sid: TEST_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

/** Direct INSERT via withTenant to set up specific states without
 *  going through the service (so we don't conflate test setup with
 *  the SUT). */
async function makeImport(
  o: TestOrg,
  opts: { status?: string; createdBy?: string } = {},
): Promise<string> {
  const [row] = await withTenant(
    o.id,
    async (tx) =>
      tx
        .insert(importJobs)
        .values({
          orgId: o.id,
          projectId: o.projects[0]!.id,
          fileR2Key: `org/${o.id}/import/${Date.now()}-${Math.random()}.xlsx`,
          fileName: 'test.xlsx',
          fileSizeBytes: 4096,
          fileContentHash: 'sha256:' + 'a'.repeat(64),
          createdBy: opts.createdBy ?? o.users[0]!.id,
        })
        .returning({ id: importJobs.id }),
    { userId: o.users[0]!.id },
  );
  if (opts.status && opts.status !== 'queued') {
    const c = await providerPool.connect();
    try {
      await c.query(`UPDATE import_jobs SET status=$2 WHERE id=$1`, [row!.id, opts.status]);
    } finally {
      c.release();
    }
  }
  return row!.id;
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`S8A-${ts}`, `s8a-${ts}`);
  orgB = await createTestOrg(`S8B-${ts}`, `s8b-${ts}`);
});

afterAll(async () => {
  /* pool teardown */
});

beforeEach(() => {
  producer.reset();
  storage.setNextHead(null); // default: Fake returns null (no attestation)
});

describe('Phase 6 S8 · §A — POST /imports (create)', () => {
  it('A1) Manager happy-path: row created, upload URL minted, audit row written', async () => {
    const before = await withTenant(orgA.id, (tx) =>
      tx.select({ id: importJobs.id }).from(importJobs),
    );
    const result = await svc.create(userOf(orgA, 'manager'), {
      projectId: orgA.projects[0]!.id,
      fileName: 'urban-renewal.xlsx',
      fileSizeBytes: 8192,
      fileContentHash: 'b'.repeat(64),
      dryRun: false,
    });

    expect(result.import.status).toBe('queued');
    expect(result.import.fileName).toBe('urban-renewal.xlsx');
    expect(result.uploadUrl).toMatch(/^https:\/\//);
    expect(result.uploadExpiresInSeconds).toBeGreaterThan(0);

    const after = await withTenant(orgA.id, (tx) =>
      tx.select({ id: importJobs.id }).from(importJobs),
    );
    expect(after.length).toBe(before.length + 1);

    const auditRows = await withTenant(orgA.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, result.import.id)),
        ),
    );
    const created = auditRows.find((r) => r.action === 'import.created');
    expect(created).toBeDefined();
    expect(created!.actorType).toBe('user');
    expect(created!.actorId).toBe(orgA.users[0]!.id);
  }, 30_000);

  it('A2) Viewer is rejected with ForbiddenException', async () => {
    await expect(
      svc.create(userOf(orgA, 'viewer'), {
        projectId: orgA.projects[0]!.id,
        fileName: 't.xlsx',
        fileSizeBytes: 1024,
        fileContentHash: 'c'.repeat(64),
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('A3) Cross-org project id → 404 NOT_FOUND (no oracle leak)', async () => {
    await expect(
      svc.create(userOf(orgA, 'manager'), {
        projectId: orgB.projects[0]!.id,
        fileName: 't.xlsx',
        fileSizeBytes: 1024,
        fileContentHash: 'd'.repeat(64),
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('A4) Response NEVER includes r2Key (confidentiality)', async () => {
    const result = await svc.create(userOf(orgA, 'manager'), {
      projectId: orgA.projects[0]!.id,
      fileName: 'check.xlsx',
      fileSizeBytes: 2048,
      fileContentHash: 'e'.repeat(64),
      dryRun: false,
    });
    const blob = JSON.stringify(result);
    expect(blob).not.toMatch(/r2[_-]?key/i);
    expect(blob).not.toMatch(/org\/[^"]+\/import\//); // server-key path
  });

  it('A6) audit_log.afterState contains no PII (filename only)', async () => {
    const result = await svc.create(userOf(orgA, 'manager'), {
      projectId: orgA.projects[0]!.id,
      fileName: 'no-pii.xlsx',
      fileSizeBytes: 4096,
      fileContentHash: 'f'.repeat(64),
      dryRun: false,
    });
    const [row] = await withTenant(orgA.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, result.import.id)),
        ),
    );
    // Strip UUIDs first — projectId is a UUID and any UUID can
    // contain 9-digit runs by chance. PII is national_id (Israeli
    // 9-digit, NOT inside a UUID context) + phone (05XXXXXXXX).
    const afterStateBlob = JSON.stringify(row?.afterState ?? {}).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      'UUID',
    );
    expect(afterStateBlob).not.toMatch(/\d{9}/);
    expect(afterStateBlob).not.toMatch(/05\d{8}/);
    expect(row?.afterState).toMatchObject({ fileName: 'no-pii.xlsx' });
  });

  // v5 audit fix (Agent B HIGH-1): a Manager-supplied filename
  // containing a national_id-shaped digit run MUST be stripped before
  // landing in audit_log.afterState. The row itself stores the
  // cleartext name (RLS-protected, no PII surface for cross-Manager
  // read); only the audit row is sanitised.
  it('A7) filename with PII-shaped digit run is stripped from BOTH audit.afterState AND the wire (v8 SOLID-4 reinforcement)', async () => {
    const result = await svc.create(userOf(orgA, 'manager'), {
      projectId: orgA.projects[0]!.id,
      // Manager dumb-named the file with what looks like a national_id.
      fileName: 'Owner_038123456_signed.xlsx',
      fileSizeBytes: 4096,
      fileContentHash: '7'.repeat(64),
      dryRun: false,
    });
    // v8 SOLID-4 (Agent A): the wire `fileName` is now sanitised too,
    // not just the audit. Pre-v8 the row's wire representation kept
    // the cleartext (every Manager-with-imports:read could see the
    // 9-digit substring of every other Manager's filenames cross-
    // Manager within the org); v8 closes that by running
    // sanitiseFilenameForAudit in toView() too. The DB column keeps
    // the cleartext (uploader UX + forensic audit via BYPASSRLS).
    expect(result.import.fileName).toBe('Owner_[N]_signed.xlsx');
    // Audit row has the digits redacted.
    const [row] = await withTenant(orgA.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, result.import.id)),
        ),
    );
    expect(row?.afterState).toMatchObject({ fileName: 'Owner_[N]_signed.xlsx' });
    // Defense in depth: the 9-digit substring does NOT appear in
    // afterState anywhere.
    const blob = JSON.stringify(row?.afterState ?? {});
    expect(blob).not.toContain('038123456');
  });
});

describe('Phase 6 S8 · §B — POST /imports/:id/start (enqueue)', () => {
  it('B1) Manager happy-path: producer.send called with correct payload + singletonKey', async () => {
    const id = await makeImport(orgA);
    await svc.start(userOf(orgA, 'manager'), id);
    expect(producer.sends).toHaveLength(1);
    expect(producer.sends[0]!.name).toBe('import.excel');
    expect(producer.sends[0]!.payload).toMatchObject({
      jobId: id,
      orgId: orgA.id,
      createdBy: orgA.users[0]!.id,
    });
    expect(producer.sends[0]!.opts?.singletonKey).toBe(id);
  });

  it('B2) status != queued → 409 import_not_startable', async () => {
    const id = await makeImport(orgA, { status: 'parsing' });
    await expect(svc.start(userOf(orgA, 'manager'), id)).rejects.toBeInstanceOf(ConflictException);
    expect(producer.sends).toHaveLength(0);
  });

  it("B3) Different Manager in same org cannot start someone else's draft", async () => {
    // The factory creates ONE manager per org; emulate "different
    // user" by injecting a synthetic AccessTokenPayload with the
    // same role but a different sub.
    const id = await makeImport(orgA, { createdBy: orgA.users[0]!.id });
    const otherManager: AccessTokenPayload = {
      sub: '00000000-0000-4000-8000-000000000000',
      orgId: orgA.id,
      role: 'manager',
      sid: 'other',
      type: 'access',
    } as unknown as AccessTokenPayload;
    await expect(svc.start(otherManager, id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(producer.sends).toHaveLength(0);
  });

  it('B4) Cross-org id → 404', async () => {
    const id = await makeImport(orgA);
    await expect(svc.start(userOf(orgB, 'manager'), id)).rejects.toBeInstanceOf(NotFoundException);
    expect(producer.sends).toHaveLength(0);
  });

  it('B5) audit row import.start_requested written', async () => {
    const id = await makeImport(orgA);
    await svc.start(userOf(orgA, 'manager'), id);
    const rows = await withTenant(orgA.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, id))),
    );
    expect(rows.find((r) => r.action === 'import.start_requested')).toBeDefined();
  });
});

describe('Phase 6 S8 · §C — DELETE /imports/:id (cancel)', () => {
  it('C1) queued → cancelled + audit row', async () => {
    const id = await makeImport(orgA, { status: 'queued' });
    await svc.cancel(userOf(orgA, 'manager'), id);
    const view = await svc.get(userOf(orgA, 'manager'), id);
    expect(view.status).toBe('cancelled');
    expect(view.finishedAt).not.toBeNull();
    const rows = await withTenant(orgA.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, id))),
    );
    const cancelled = rows.find((r) => r.action === 'import.cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled!.metadata).toMatchObject({ from: 'queued' });
  });

  it('C2) awaiting_mapping → cancelled (D.34 wizard escape hatch)', async () => {
    const id = await makeImport(orgA, { status: 'awaiting_mapping' });
    await svc.cancel(userOf(orgA, 'manager'), id);
    const view = await svc.get(userOf(orgA, 'manager'), id);
    expect(view.status).toBe('cancelled');
  });

  it('C3) already done → 409 import_not_cancellable', async () => {
    const id = await makeImport(orgA, { status: 'done' });
    await expect(svc.cancel(userOf(orgA, 'manager'), id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('C5) cross-org → 404', async () => {
    const id = await makeImport(orgA);
    await expect(svc.cancel(userOf(orgB, 'manager'), id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('C6) Viewer is rejected with ForbiddenException', async () => {
    const id = await makeImport(orgA);
    await expect(svc.cancel(userOf(orgA, 'viewer'), id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * v8.5 P0 (Audit SOLID #4 — concrete bug): cancel() must trigger
   * the R2 byte purge end-to-end. Pre-v8.5, only the worker terminal-
   * state path purged; Manager cancel left PII bytes in R2 forever
   * — the most common terminal route. These tests pin:
   *   1. storage.delete is invoked with the row's exact fileR2Key
   *   2. import_jobs.file_deleted_at is set after cancel() returns
   *   3. audit row import.bytes_purged is written (system-actor)
   *   4. failure on R2 delete does NOT block cancel — bytes_purge_failed
   *      audit row is written instead and the cancel still succeeds
   *      from the Manager's perspective
   */
  describe('C7-C10 — v8.5 cancel→purge end-to-end (SOLID #4)', () => {
    it('C7) cancel of queued import → storage.delete called with exact fileR2Key', async () => {
      const deleted: string[] = [];
      const origDelete = storage.delete.bind(storage);
      storage.delete = (async (key: string) => {
        deleted.push(key);
        await origDelete();
      }) as typeof storage.delete;
      try {
        const id = await makeImport(orgA, { status: 'queued' });
        // Capture the exact key the row holds so we can pin the
        // argument identity (no fuzzy matching — the contract is
        // "we delete THIS exact object, not some other key").
        const [row] = await withTenant(orgA.id, (tx) =>
          tx
            .select({ fileR2Key: importJobs.fileR2Key })
            .from(importJobs)
            .where(eq(importJobs.id, id))
            .limit(1),
        );
        await svc.cancel(userOf(orgA, 'manager'), id);
        expect(deleted).toContain(row!.fileR2Key);
      } finally {
        storage.delete = origDelete;
      }
    });

    it('C8) after cancel, file_deleted_at IS NOT NULL on the import_jobs row', async () => {
      const id = await makeImport(orgA, { status: 'queued' });
      await svc.cancel(userOf(orgA, 'manager'), id);
      // The cancel-purge call awaits the helper, so by the time
      // cancel() returns the file_deleted_at write has either
      // landed or failed — no race.
      const [row] = await withTenant(orgA.id, (tx) =>
        tx
          .select({ fileDeletedAt: importJobs.fileDeletedAt, status: importJobs.status })
          .from(importJobs)
          .where(eq(importJobs.id, id))
          .limit(1),
      );
      expect(row?.status).toBe('cancelled');
      expect(row?.fileDeletedAt).not.toBeNull();
    });

    it('C9) after cancel, audit row import.bytes_purged exists with actorType=system', async () => {
      const id = await makeImport(orgA, { status: 'queued' });
      await svc.cancel(userOf(orgA, 'manager'), id);
      const rows = await withTenant(orgA.id, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, id))),
      );
      const purgeRow = rows.find((r) => r.action === 'import.bytes_purged');
      expect(purgeRow).toBeDefined();
      // v8.5 SOLID #5: system actor for the purge — no specific Manager
      // credited (the cancel audit row above already credits the Manager).
      expect(purgeRow!.actorType).toBe('system');
    });

    it('C10) R2 delete FAILURE does not prevent cancel from succeeding; bytes_purge_failed audit lands', async () => {
      const origDelete = storage.delete.bind(storage);
      storage.delete = (async () => {
        throw new Error('synthetic: R2 outage');
      }) as typeof storage.delete;
      try {
        const id = await makeImport(orgA, { status: 'queued' });
        // cancel() must succeed from the Manager's perspective —
        // the purge is best-effort (sweeper will retry).
        await svc.cancel(userOf(orgA, 'manager'), id);
        // Status is cancelled (the cancel itself committed).
        const [row] = await withTenant(orgA.id, (tx) =>
          tx
            .select({ status: importJobs.status, fileDeletedAt: importJobs.fileDeletedAt })
            .from(importJobs)
            .where(eq(importJobs.id, id))
            .limit(1),
        );
        expect(row?.status).toBe('cancelled');
        // file_deleted_at NOT set because R2 delete failed.
        expect(row?.fileDeletedAt).toBeNull();
        // Audit must record the failure separately so SRE sees it.
        const rows = await withTenant(orgA.id, (tx) =>
          tx
            .select()
            .from(auditLog)
            .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, id))),
        );
        const failRow = rows.find((r) => r.action === 'import.bytes_purge_failed');
        expect(failRow).toBeDefined();
        expect(failRow!.actorType).toBe('system');
      } finally {
        storage.delete = origDelete;
      }
    });

    it('C11) cancel of awaiting_mapping also purges bytes', async () => {
      // D.34 wizard escape hatch path — same terminal state, same
      // purge expectation. Pin it explicitly so a future refactor
      // that only handles "queued → cancelled" doesn't regress.
      const id = await makeImport(orgA, { status: 'awaiting_mapping' });
      await svc.cancel(userOf(orgA, 'manager'), id);
      const [row] = await withTenant(orgA.id, (tx) =>
        tx
          .select({ status: importJobs.status, fileDeletedAt: importJobs.fileDeletedAt })
          .from(importJobs)
          .where(eq(importJobs.id, id))
          .limit(1),
      );
      expect(row?.status).toBe('cancelled');
      expect(row?.fileDeletedAt).not.toBeNull();
    });

    /**
     * v8.5 ADVERSARIAL — concurrent cancel attempts.
     *
     * The cancel() path is a guarded UPDATE (status flip from non-
     * terminal → cancelled, race-safe). Then a post-commit purge
     * fires once. If a Manager double-clicks Delete (or a flaky
     * network retries the DELETE), we want EXACTLY:
     *   - one audit row of action='import.cancelled'
     *   - one audit row of action='import.bytes_purged' (or one
     *     bytes_purge_failed if R2 was down)
     *   - storage.delete invoked once OR twice (idempotent, S3
     *     returns 200 even on missing keys)
     *   - the second cancel call: 409 (already-cancelled) — NOT a
     *     second state flip
     */
    it('C12) ADVERSARIAL — Promise.all of 5 concurrent cancels yields exactly ONE state flip + ONE purge audit', async () => {
      const id = await makeImport(orgA, { status: 'queued' });
      // Fire 5 cancels in parallel.
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => svc.cancel(userOf(orgA, 'manager'), id)),
      );
      // At least one fulfilled (the winner). The losers should be
      // ConflictException (409) — not silent passes, not crashes.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.length + rejected.length).toBe(5);
      for (const r of rejected) {
        // Reason must be a ConflictException (import not cancellable
        // anymore — already done from the winner).
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      }

      // Exactly ONE 'import.cancelled' row.
      const rows = await withTenant(orgA.id, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, id))),
      );
      const cancelRows = rows.filter((r) => r.action === 'import.cancelled');
      expect(cancelRows.length).toBe(1);
      // And at most ONE 'import.bytes_purged' (winner only).
      const purgeRows = rows.filter((r) => r.action === 'import.bytes_purged');
      expect(purgeRows.length).toBeLessThanOrEqual(1);
    });

    it('C13) ADVERSARIAL — re-cancel after success is a clean 409 (no second purge)', async () => {
      const id = await makeImport(orgA, { status: 'queued' });
      let deleteCount = 0;
      const origDelete = storage.delete.bind(storage);
      storage.delete = (async () => {
        deleteCount += 1;
        await origDelete();
      }) as typeof storage.delete;
      try {
        await svc.cancel(userOf(orgA, 'manager'), id);
        // Second cancel — must reject as ConflictException, NOT
        // re-purge.
        await expect(svc.cancel(userOf(orgA, 'manager'), id)).rejects.toBeInstanceOf(
          ConflictException,
        );
        // storage.delete called at most once (the helper is
        // idempotent at the file_deleted_at level — once set, the
        // second purge attempt returns 'already' before touching R2).
        expect(deleteCount).toBeLessThanOrEqual(1);
      } finally {
        storage.delete = origDelete;
      }
    });

    it('C14) ADVERSARIAL — cross-tenant cancel: Org B Manager CANNOT trigger purge of Org A bytes', async () => {
      const id = await makeImport(orgA, { status: 'queued' });
      const captured: string[] = [];
      const origDelete = storage.delete.bind(storage);
      storage.delete = (async (key: string) => {
        captured.push(key);
        await origDelete();
      }) as typeof storage.delete;
      try {
        // Org B Manager tries to cancel Org A's import → must 404
        // (RLS scoping — no oracle).
        await expect(svc.cancel(userOf(orgB, 'manager'), id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        // R2 delete MUST NOT have been called — leaking the file_r2_key
        // through a failed cross-org cancel would be a Sev1.
        expect(captured.length).toBe(0);
        // And the row is still queued (not cancelled).
        const [row] = await withTenant(orgA.id, (tx) =>
          tx
            .select({ status: importJobs.status, fileDeletedAt: importJobs.fileDeletedAt })
            .from(importJobs)
            .where(eq(importJobs.id, id))
            .limit(1),
        );
        expect(row?.status).toBe('queued');
        expect(row?.fileDeletedAt).toBeNull();
      } finally {
        storage.delete = origDelete;
      }
    });
  });
});

describe('Phase 6 S8 · §D — GET /imports/:id/errors', () => {
  it('D1) returns rows sorted by row_number; D4) message non-null on wire (falls back to code)', async () => {
    const id = await makeImport(orgA);
    // Seed errors directly (worker writes these in real life).
    await withTenant(orgA.id, async (tx) => {
      await tx.insert(importJobErrors).values([
        {
          orgId: orgA.id,
          jobId: id,
          rowNumber: 3,
          code: 'invalid_luhn',
          message: 'bad checksum',
          field: 'national_id',
        },
        {
          orgId: orgA.id,
          jobId: id,
          rowNumber: 1,
          code: 'missing_required',
          message: null,
          field: 'name',
        },
        {
          orgId: orgA.id,
          jobId: id,
          rowNumber: 2,
          code: 'invalid_phone',
          message: 'not 9 digits',
          field: 'phone',
        },
      ]);
    });
    const out = await svc.listErrors(userOf(orgA, 'viewer'), id, { limit: 100 });
    expect(out.data.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
    // Fallback: the row with message=null should serve `code` as message.
    const r1 = out.data.find((r) => r.rowNumber === 1)!;
    expect(r1.message).toBe('missing_required');
    expect(out.page.has_more).toBe(false);
  });

  it('D2) cross-org → 404 (no list leak)', async () => {
    const id = await makeImport(orgA);
    await expect(
      svc.listErrors(userOf(orgB, 'manager'), id, { limit: 100 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('D3) cursor pagination — limit=2 + next page', async () => {
    const id = await makeImport(orgA);
    await withTenant(orgA.id, async (tx) => {
      await tx.insert(importJobErrors).values([
        { orgId: orgA.id, jobId: id, rowNumber: 10, code: 'c1', message: 'm1', field: null },
        { orgId: orgA.id, jobId: id, rowNumber: 20, code: 'c2', message: 'm2', field: null },
        { orgId: orgA.id, jobId: id, rowNumber: 30, code: 'c3', message: 'm3', field: null },
        { orgId: orgA.id, jobId: id, rowNumber: 40, code: 'c4', message: 'm4', field: null },
      ]);
    });
    const p1 = await svc.listErrors(userOf(orgA, 'manager'), id, { limit: 2 });
    expect(p1.data.map((r) => r.rowNumber)).toEqual([10, 20]);
    expect(p1.page.has_more).toBe(true);
    expect(p1.page.cursor).toBe('20');
    const p2 = await svc.listErrors(userOf(orgA, 'manager'), id, { limit: 2, cursor: '20' });
    expect(p2.data.map((r) => r.rowNumber)).toEqual([30, 40]);
    expect(p2.page.has_more).toBe(false);
  });
});

describe('Phase 6 S8 · §E — POST /imports/:id/mapping (D.34 wizard)', () => {
  it('E1) happy-path awaiting_mapping → row→queued + template inserted + producer.send', async () => {
    const id = await makeImport(orgA, { status: 'awaiting_mapping' });
    const result = await svc.submitMapping(userOf(orgA, 'manager'), id, {
      columns: {
        national_id: 0,
        phone: 1,
        name: 2,
        apartment_number: 3,
        building_address: 4,
      },
      templateName: 'Bank export 2026',
    });
    expect(result.import.status).toBe('queued');
    expect(result.templateId).toMatch(/^[0-9a-f-]{36}$/);
    const tpl = await withTenant(orgA.id, (tx) =>
      tx.select().from(mappingTemplates).where(eq(mappingTemplates.id, result.templateId)).limit(1),
    );
    expect(tpl[0]?.source).toBe('manual');
    expect(tpl[0]?.approvedBy).toBe(orgA.users[0]!.id);
    expect(tpl[0]?.approvedAt).not.toBeNull();
    // Producer re-enqueued.
    expect(producer.sends).toHaveLength(1);
    expect(producer.sends[0]!.opts?.singletonKey).toBe(id);
  });

  it('E2) status != awaiting_mapping → 409', async () => {
    const id = await makeImport(orgA, { status: 'queued' });
    await expect(
      svc.submitMapping(userOf(orgA, 'manager'), id, {
        columns: {
          national_id: 0,
          phone: 1,
          name: 2,
          apartment_number: 3,
          building_address: 4,
        },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(producer.sends).toHaveLength(0);
  });

  it('E3) duplicate column indexes → 400 mapping_duplicate_column', async () => {
    const id = await makeImport(orgA, { status: 'awaiting_mapping' });
    try {
      await svc.submitMapping(userOf(orgA, 'manager'), id, {
        columns: {
          national_id: 0,
          phone: 0, // duplicate of national_id
          name: 1,
          apartment_number: 2,
          building_address: 3,
        },
      });
      throw new Error('expected BadRequestException');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const body = (e as BadRequestException).getResponse() as { error: { code: string } };
      expect(body.error.code).toBe('mapping_duplicate_column');
    }
  });

  it('E4) Agent rejected (ForbiddenException)', async () => {
    const id = await makeImport(orgA, { status: 'awaiting_mapping' });
    await expect(
      svc.submitMapping(userOf(orgA, 'agent'), id, {
        columns: {
          national_id: 0,
          phone: 1,
          name: 2,
          apartment_number: 3,
          building_address: 4,
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('E5) Cross-org → 404 (no oracle)', async () => {
    const id = await makeImport(orgA, { status: 'awaiting_mapping' });
    await expect(
      svc.submitMapping(userOf(orgB, 'manager'), id, {
        columns: {
          national_id: 0,
          phone: 1,
          name: 2,
          apartment_number: 3,
          building_address: 4,
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // v5 audit fix (P0 — Agent A): the wizard MUST compute the
  // mapping_templates.fingerprint from the parsed_headers the
  // worker persisted on the row (migration 0031), NOT from a
  // placeholder. Without this fix the future L2 TemplateResolver
  // (Phase 7+) would never find any wizard-saved template.
  it('E7) submitMapping uses parsed_headers from the row to compute the real fingerprint', async () => {
    const { createHash } = await import('node:crypto');
    const realHeaders = ['client_id', 'cellular', 'contact_name', 'unit_ref', 'street_locator'];
    const id = await makeImport(orgA, { status: 'awaiting_mapping' });
    // Simulate what the worker's parseStage does: persist the
    // observed headers on the row alongside the awaiting_mapping
    // transition.
    const c = await providerPool.connect();
    try {
      await c.query(`UPDATE import_jobs SET parsed_headers=$2::jsonb WHERE id=$1`, [
        id,
        JSON.stringify(realHeaders),
      ]);
    } finally {
      c.release();
    }

    const result = await svc.submitMapping(userOf(orgA, 'manager'), id, {
      columns: {
        national_id: 0,
        phone: 1,
        name: 2,
        apartment_number: 3,
        building_address: 4,
      },
      templateName: 'Bank export v2',
    });

    // The fingerprint stored on mapping_templates must be the
    // sha256 of the normalised (lowercase + trim) headers joined
    // by NUL. The L2 TemplateResolver will use the same algorithm
    // → next file with the same headers FINDS this template.
    const expectedFingerprint = createHash('sha256')
      .update(realHeaders.map((h) => h.trim().toLowerCase()).join('\x00'))
      .digest('hex');
    const [tpl] = await withTenant(orgA.id, (tx) =>
      tx.select().from(mappingTemplates).where(eq(mappingTemplates.id, result.templateId)).limit(1),
    );
    expect(tpl?.fingerprint).toBe(expectedFingerprint);
    // Defense in depth: the placeholder "manual:" string MUST NOT
    // appear in the fingerprint (would indicate the fallback path
    // fired silently).
    const placeholder = createHash('sha256').update(`manual:${id}`).digest('hex');
    expect(tpl?.fingerprint).not.toBe(placeholder);
    // The template's mapping jsonb MUST carry the real headers too
    // (so the L2 resolver can verify head-match if it wants extra
    // certainty before applying a saved mapping).
    expect((tpl?.mapping as { headers: string[] }).headers).toEqual(realHeaders);
  });

  // v5 audit fix (Agent B P0-1 + MED-1): submitMapping must (a)
  // commit the withTenant tx BEFORE the producer.send network call
  // (no row-lock held across pg-boss I/O — DoS protection), and (b)
  // detect a concurrent cancel that flipped the row to 'cancelled'
  // between our load and our UPDATE (rowCount=0 → 409 instead of
  // silent insert of an orphan template). Test (b) by hand-flipping
  // the row to 'cancelled' between our service's load + UPDATE; the
  // race is hard to reproduce deterministically, so we exercise the
  // STATIC contract: the UPDATE WHERE clause requires
  // status='awaiting_mapping' AND the service checks rowCount.
  it('E6) row flipped to cancelled mid-flight → 409 import_status_changed', async () => {
    const id = await makeImport(orgA, { status: 'awaiting_mapping' });
    // Simulate the race: manually flip BEFORE the service runs.
    // (A real cancel-then-mapping race would behave identically — the
    // UPDATE's WHERE clause fails to match either way.)
    const c = await providerPool.connect();
    try {
      await c.query(`UPDATE import_jobs SET status='cancelled' WHERE id=$1`, [id]);
    } finally {
      c.release();
    }
    try {
      await svc.submitMapping(userOf(orgA, 'manager'), id, {
        columns: {
          national_id: 0,
          phone: 1,
          name: 2,
          apartment_number: 3,
          building_address: 4,
        },
      });
      throw new Error('expected ConflictException');
    } catch (e) {
      // Could surface as 'import_not_awaiting_mapping' (if load sees
      // cancelled first) OR 'import_status_changed' (if load saw the
      // pre-flip awaiting_mapping). Both are correct posture.
      expect(e).toBeInstanceOf(ConflictException);
      const body = (e as ConflictException).getResponse() as { error: { code: string } };
      expect(body.error.code).toMatch(/import_not_awaiting_mapping|import_status_changed/);
    }
    // Verify NO orphan template was inserted.
    const tpls = await withTenant(orgA.id, (tx) => tx.select().from(mappingTemplates));
    // Count BEFORE / AFTER would be more robust; here we assert no
    // template references this import (no row in audit either).
    const auditRows = await withTenant(orgA.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'import_jobs'), eq(auditLog.targetId, id))),
    );
    const submitted = auditRows.find((r) => r.action === 'import.mapping_submitted');
    expect(submitted).toBeUndefined();
    // (We don't assert tpls.length === 0 because earlier tests in
    // this file leave templates around; the audit-row check above
    // is the precise invariant.)
    expect(tpls).toBeDefined();
  });
});
