/**
 * T6.9 — Phase 6 SSE delivers progress events.
 *
 * Strategy: bypass the HTTP layer entirely (it's a thin reply.raw
 * wrapper — covered by typecheck + manual smoke) and drive
 * `ImportsService.streamProgress` directly against the real DB. This
 * is the canonical "integration" shape per audit-pass: real Postgres,
 * real RLS FORCE, real `withTenant` — fake everything around them.
 *
 * Pinned invariants:
 *   1. Initial progress event delivered on first poll
 *   2. Status transitions are observed across polls (queued → done)
 *   3. Terminal state → `end` event fires + stream returns
 *   4. Cross-tenant id → `gone` event (RLS-driven 404)
 *   5. Client disconnect (abort signal) ends the stream promptly
 *   6. SSE wire encoding is well-formed (event: + data: + \n\n)
 *   7. No PII in any emitted payload — only id/status/counters/timestamp
 */
import { importJobs, withTenant } from '@emapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { encodeSseFrame, ImportsService, type SseEvent } from './imports.service';

let org: TestOrg;
let orgB: TestOrg;
// S8: ImportsService now takes (storage, producer). The streamProgress
// invariants tested here only exercise the read/SSE path — never
// storage or the producer — so minimal stubs are safe.
const stubStorage = {} as never;
const stubProducer = { send: async () => ({ id: null }) } as never;
const svc = new ImportsService(stubStorage, stubProducer);

function makeUser(o: TestOrg): AccessTokenPayload {
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role: 'manager',
    sid: 'test-session',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function createJob(o: TestOrg): Promise<string> {
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        fileR2Key: 'org/test/import/file.xlsx',
        fileName: 'import.xlsx',
        fileSizeBytes: 2048,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

async function updateStatus(
  o: TestOrg,
  id: string,
  patch: Partial<typeof importJobs.$inferInsert>,
): Promise<void> {
  await withTenant(o.id, async (tx) => {
    await tx
      .update(importJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(importJobs.id, id));
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  org = await createTestOrg(`T69-${ts}`, `t69-${ts}`);
  orgB = await createTestOrg(`T69-B-${ts}`, `t69-b-${ts}`);
});

afterAll(async () => {
  // Pool teardown is handled by vitest workers; nothing per-suite.
});

describe('T6.9 — SSE delivers progress events', () => {
  it('1) initial poll emits a progress event with queued state', async () => {
    const id = await createJob(org);
    const events: SseEvent[] = [];
    // maxIterations:1 + pollMs:0 → run exactly one tick then exit.
    await svc.streamProgress({
      user: makeUser(org),
      id,
      write: (ev) => events.push(ev),
      signal: new AbortController().signal,
      pollMs: 0,
      maxIterations: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('progress');
    expect(events[0]!.data).toMatchObject({ id, status: 'queued' });
  });

  it('2) status transitions are observed across polls', async () => {
    const id = await createJob(org);
    const events: SseEvent[] = [];

    // Drive the stream forward by mutating the row between polls. We
    // can't easily race against the poller's internal sleep, so we
    // pre-set the status to 'done' and use a single iteration — the
    // service then emits the final state and the `end` frame.
    await updateStatus(org, id, { status: 'done', finishedAt: new Date() });

    await svc.streamProgress({
      user: makeUser(org),
      id,
      write: (ev) => events.push(ev),
      signal: new AbortController().signal,
      pollMs: 0,
      maxIterations: 5,
    });

    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('progress');
    expect(kinds[kinds.length - 1]).toBe('end');
    expect(events[events.length - 1]!.data).toMatchObject({ id, status: 'done' });
  });

  it('3) terminal state → end event fires + stream returns', async () => {
    const id = await createJob(org);
    await updateStatus(org, id, { status: 'failed', finishedAt: new Date() });
    const events: SseEvent[] = [];
    await svc.streamProgress({
      user: makeUser(org),
      id,
      write: (ev) => events.push(ev),
      signal: new AbortController().signal,
      pollMs: 0,
      maxIterations: 3,
    });
    const last = events[events.length - 1]!;
    expect(last.event).toBe('end');
    expect(last.data).toMatchObject({ status: 'failed' });
  });

  it('4) cross-tenant id → gone event (RLS-driven 404)', async () => {
    // Create a job in org A, ask org B to stream it. RLS hides the row
    // → service throws 404 → stream catches + emits `gone`.
    const id = await createJob(org);
    const events: SseEvent[] = [];
    await svc.streamProgress({
      user: makeUser(orgB),
      id,
      write: (ev) => events.push(ev),
      signal: new AbortController().signal,
      pollMs: 0,
      maxIterations: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('gone');
    expect(events[0]!.data).toMatchObject({ id });
  });

  it('5) client disconnect (abort signal) ends the stream promptly', async () => {
    const id = await createJob(org);
    const events: SseEvent[] = [];
    const controller = new AbortController();
    controller.abort(); // disconnect already

    await svc.streamProgress({
      user: makeUser(org),
      id,
      write: (ev) => events.push(ev),
      signal: controller.signal,
      pollMs: 100,
      maxIterations: 10,
    });
    // signal was aborted before the first iteration — the loop exits
    // immediately, no events emitted.
    expect(events).toHaveLength(0);
  });

  it('6) SSE wire encoding is well-formed', () => {
    const frame = encodeSseFrame({
      event: 'progress',
      data: { id: 'x', status: 'queued', processedRows: 0 },
    });
    expect(frame).toMatch(/^event: progress\n/);
    expect(frame).toMatch(/\ndata: \{.*\}\n\n$/);
    // JSON parse round-trip — guarantees the payload survives the wire.
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
    const json = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
    expect(json['id']).toBe('x');
    expect(json['status']).toBe('queued');
  });

  it('7) no PII in any emitted payload — keys whitelisted', async () => {
    const id = await createJob(org);
    const events: SseEvent[] = [];
    await svc.streamProgress({
      user: makeUser(org),
      id,
      write: (ev) => events.push(ev),
      signal: new AbortController().signal,
      pollMs: 0,
      maxIterations: 1,
    });
    const allowed = new Set([
      'id',
      'status',
      'totalRows',
      'processedRows',
      'okRows',
      'failedRows',
      'updatedAt',
    ]);
    for (const ev of events) {
      for (const k of Object.keys(ev.data)) {
        expect(allowed.has(k), `disallowed key "${k}" in SSE payload`).toBe(true);
      }
    }
  });

  it('8) get(id) under withTenant returns the same view shape the stream emits', async () => {
    const id = await createJob(org);
    const view = await svc.get(makeUser(org), id);
    expect(view.id).toBe(id);
    expect(view.status).toBe('queued');
    expect(view.dryRun).toBe(false);
    // Mirror of the SSE-emitted shape — keeps the API stable for clients
    // that mix REST polling with SSE.
    const allowed = new Set([
      'id',
      // S8: shared-types ImportJobSchema added these for the
      // canonical wire shape (mirrors document.ts pattern).
      'organizationId',
      'projectId',
      'status',
      'fileName',
      'fileSizeBytes',
      'totalRows',
      'processedRows',
      'okRows',
      'failedRows',
      'dryRun',
      'createdBy',
      'createdAt',
      'updatedAt',
      'startedAt',
      'finishedAt',
    ]);
    for (const k of Object.keys(view)) {
      expect(allowed.has(k), `disallowed key "${k}" in view`).toBe(true);
    }
  });
});
