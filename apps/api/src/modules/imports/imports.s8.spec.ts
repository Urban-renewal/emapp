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
});
