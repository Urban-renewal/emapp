/**
 * #6 import "real change-summary" (design §6) — DTO/WIRE axis.
 *
 * INDEPENDENT test-author pass (written FIRST, before the builder).
 * RED against current code; GREEN after the builder.
 *
 * The worker spec (apps/worker/test/import.change-summary.spec.ts) pins
 * that validateStage COMPUTES + PERSISTS change_summary on the row. THIS
 * spec pins the other half of the contract: the summary the FE reads must
 * be SURFACED in the status/result DTO — i.e. ImportsService.get(...)
 * (and therefore GET /imports/:id) must carry it, not just the DB row.
 *
 * HARNESS (mirrored from imports.s8.spec.ts):
 *   - ImportsService instantiated directly with a Fake storage + Fake
 *     producer, hitting real Neon for RLS/state.
 *   - makeImport(...) inserts a row via withTenant; we then stamp a
 *     change_summary + flip to 'awaiting_confirm' via the BYPASSRLS
 *     providerPool (raw SQL — the column doesn't exist in the Drizzle
 *     schema YET, so we can't set it through the typed insert).
 *   - svc.get(...) returns the wire view; we assert `changeSummary` is
 *     present with the stamped shape.
 *
 * RED now (two possible failure shapes, both correct):
 *   (a) the `UPDATE import_jobs SET change_summary=...` throws because the
 *       column is absent → the test setup fails loudly, OR
 *   (b) the column exists but toView() doesn't map it → `changeSummary`
 *       is undefined on the view → assertion fails.
 *
 * BUILDER INTEGRATION POINT:
 *   - packages/shared-types/src/import.ts ImportJobSchema: add an optional
 *     `changeSummary` object.
 *   - apps/api/src/modules/imports/imports.service.ts toView(): map
 *     row.changeSummary onto the view.
 */
import { importJobs, withTenant } from '@emapp/db';
import { type IJobProducer, type JobSendOptions, type JobSendResult } from '@emapp/jobs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ImportsService } from './imports.service';

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

class FakeStorage {
  async getUploadUrl(): Promise<string> {
    return 'https://fake-storage.test/upload/key';
  }
  async getDownloadUrl(): Promise<string> {
    return 'https://fake-storage.test/download/key';
  }
  async delete(): Promise<void> {}
  async head(): Promise<{ contentLength: number } | null> {
    return null;
  }
  async healthCheck(): Promise<void> {}
  getObjectStream(): never {
    throw new Error('not used in this DTO spec');
  }
}

let orgA: TestOrg;
const producer = new FakeProducer();
const storage = new FakeStorage();
const svc = new ImportsService(storage as never, producer);

const TEST_SID = '00000000-0000-4000-8000-00000000abcd';

function userOf(o: TestOrg, role: 'manager' | 'agent' | 'viewer' = 'manager'): AccessTokenPayload {
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role,
    sid: TEST_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function makeImport(o: TestOrg): Promise<string> {
  const [row] = await withTenant(
    o.id,
    async (tx) =>
      tx
        .insert(importJobs)
        .values({
          orgId: o.id,
          projectId: o.projects[0]!.id,
          fileR2Key: `org/${o.id}/import/${Date.now()}-${Math.random()}.xlsx`,
          fileName: 'preview.xlsx',
          fileSizeBytes: 4096,
          fileContentHash: 'sha256:' + 'a'.repeat(64),
          createdBy: o.users[0]!.id,
          requireConfirm: true,
        })
        .returning({ id: importJobs.id }),
    { userId: o.users[0]!.id },
  );
  return row!.id;
}

/** Stamp a change_summary + flip to awaiting_confirm via raw SQL on the
 *  BYPASSRLS pool. The column doesn't exist in the Drizzle schema yet,
 *  so this is the only way to set it. If the column is absent the query
 *  THROWS — which surfaces the RED gap in setup. */
async function stampSummary(jobId: string, summary: Record<string, number>): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE import_jobs SET status='awaiting_confirm', change_summary=$2::jsonb WHERE id=$1`,
      [jobId, JSON.stringify(summary)],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  orgA = await createTestOrg(`CSDTO-${Date.now()}`, `csdto-${Date.now()}`);
});

afterAll(() => {
  producer.reset();
});

describe('#6 change-summary — surfaced on the status/result DTO', () => {
  it('GET /imports/:id view carries changeSummary (RED: column/toView mapping absent)', async () => {
    const id = await makeImport(orgA);
    const summary = {
      ownersCreated: 3,
      ownersMatched: 1,
      apartmentsCreated: 2,
      buildingsCreated: 1,
      ownershipsCreated: 3,
    };
    // RED shape (a): this throws if the column doesn't exist yet.
    await stampSummary(id, summary);

    const view = (await svc.get(userOf(orgA, 'manager'), id)) as unknown as {
      status: string;
      changeSummary?: Record<string, number> | null;
    };
    expect(view.status).toBe('awaiting_confirm');
    // RED shape (b): toView doesn't map change_summary → undefined.
    expect(view.changeSummary).toBeDefined();
    expect(view.changeSummary).toMatchObject(summary);
    // The headline number the FE needs: N new owners (not "0 changes").
    expect(view.changeSummary?.ownersCreated).toBe(3);
  }, 30_000);
});
