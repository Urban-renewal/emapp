/**
 * Test #8 — SSE controller HTTP layer (audit-pass v2 Track 2).
 *
 * The earlier T6.9 spec (imports-stream.spec.ts) invokes
 * `ImportsService.streamProgress` directly — the actual HTTP wire
 * (Fastify `reply.raw` writes, the post-headers-sent error catch from
 * audit-pass v1 M2, the `req.raw.on('close')` plumbing) was not
 * directly tested. Audit observation: "manual smoke is not a test".
 *
 * Implementation note: vitest's TS transformer does NOT emit
 * decorator metadata (Nest's DI requires it). Spinning up a real
 * NestFastifyApplication via Test.createTestingModule fails with
 * "this.imports undefined" because constructor-param types are
 * invisible at runtime. We could add an @swc/core transformer to fix
 * that, but it's significant test-infra surgery for one spec.
 *
 * Pragmatic alternative: instantiate ImportsController MANUALLY with
 * explicit deps, drive its stream() method directly with mock
 * FastifyRequest / FastifyReply objects, and capture the bytes
 * written to reply.raw. This tests EXACTLY the controller code
 * (writeHead, ':stream-open' immediate flush, abort-on-disconnect,
 * post-headers error catch) without Nest DI being in the way.
 *
 * The Nest authentication chain (AuthGuard, TenantGuard,
 * AuthorizationGuard) is verified by the existing
 * auth.contract.spec.ts + the policy.spec.ts D.17 matrix proof.
 * What THIS spec covers is the wire-format contract that lives
 * between the guards and the service.
 *
 * Pinned invariants:
 *   1. writeHead is called with status=200 + the four SSE headers
 *   2. ':stream-open' is the first byte sequence on the wire
 *   3. progress event frames follow the SSE wire format
 *   4. terminal state writes the 'end' event then reply.raw.end()
 *   5. service-throw after headers-sent → reply emits
 *      `event: end, status: failed` (M2 audit-pass guarantee)
 *   6. req.raw `close` listener fires AbortController so a
 *      mid-stream disconnect halts streamProgress promptly
 *   7. cross-tenant id (RLS-driven NotFoundException) → 'gone'
 */
import { EventEmitter } from 'node:events';

import { importJobs, withTenant } from '@emapp/db';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

let org: TestOrg;
let orgB: TestOrg;

/** Capture every byte written to reply.raw. */
interface CapturedReply {
  raw: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    write: (chunk: string | Buffer) => boolean;
    end: () => void;
  };
  capturedStatus: number;
  capturedHeaders: Record<string, string>;
  capturedBody: string;
  ended: boolean;
}

function makeReply(): CapturedReply {
  const out: CapturedReply = {
    capturedStatus: 0,
    capturedHeaders: {},
    capturedBody: '',
    ended: false,
    raw: {
      writeHead(status, headers) {
        out.capturedStatus = status;
        out.capturedHeaders = { ...headers };
      },
      write(chunk) {
        out.capturedBody += chunk.toString('utf8');
        return true;
      },
      end() {
        out.ended = true;
      },
    },
  };
  return out;
}

/** Bare-bones FastifyRequest mock — only what the controller touches:
 *  `req.raw` (used for the `'close'` event listener). */
function makeReq(): FastifyRequest {
  const ev = new EventEmitter();
  return {
    raw: ev as unknown as FastifyRequest['raw'],
    // The rest of FastifyRequest's surface is unused by stream().
  } as unknown as FastifyRequest;
}

async function createJob(o: TestOrg): Promise<string> {
  const inserted = await withTenant(o.id, async (tx) =>
    tx
      .insert(importJobs)
      .values({
        orgId: o.id,
        fileR2Key: `org/${o.id}/import/sse.xlsx`,
        fileName: 'sse.xlsx',
        fileSizeBytes: 1024,
        fileContentHash: 'sha256:abc',
        createdBy: o.users[0]!.id,
      })
      .returning({ id: importJobs.id }),
  );
  return inserted[0]!.id;
}

async function setStatus(jobId: string, status: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE import_jobs SET status=$2, finished_at=now() WHERE id=$1`, [
      jobId,
      status,
    ]);
  } finally {
    c.release();
  }
}

function fakeUser(o: TestOrg): AccessTokenPayload {
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role: 'manager',
    sid: 'test-sid',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  org = await createTestOrg(`HTTP-${ts}`, `http-${ts}`);
  orgB = await createTestOrg(`HTTP-B-${ts}`, `http-b-${ts}`);
});

afterAll(async () => {
  /* pool teardown by vitest workers */
});

describe('Test #8 — SSE controller HTTP-wire contract', () => {
  it('1) writeHead receives 200 + the four SSE headers', async () => {
    const ctrl = new ImportsController(new ImportsService());
    const jobId = await createJob(org);
    await setStatus(jobId, 'done');
    const reply = makeReply();

    await ctrl.stream(fakeUser(org), jobId, makeReq(), reply as unknown as FastifyReply);

    expect(reply.capturedStatus).toBe(200);
    expect(reply.capturedHeaders['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(reply.capturedHeaders['Cache-Control']).toBe('no-cache, no-transform');
    expect(reply.capturedHeaders['X-Accel-Buffering']).toBe('no');
    expect(reply.capturedHeaders['Connection']).toBe('keep-alive');
  }, 30_000);

  it('2) `:stream-open` is the first byte sequence on the wire', async () => {
    const ctrl = new ImportsController(new ImportsService());
    const jobId = await createJob(org);
    await setStatus(jobId, 'done');
    const reply = makeReply();

    await ctrl.stream(fakeUser(org), jobId, makeReq(), reply as unknown as FastifyReply);
    expect(reply.capturedBody.startsWith(': stream-open\n\n')).toBe(true);
  }, 30_000);

  it('3) terminal state → body contains progress + end frames (SSE format)', async () => {
    const ctrl = new ImportsController(new ImportsService());
    const jobId = await createJob(org);
    await setStatus(jobId, 'done');
    const reply = makeReply();

    await ctrl.stream(fakeUser(org), jobId, makeReq(), reply as unknown as FastifyReply);

    expect(reply.capturedBody).toMatch(/event: progress\ndata: \{[^}]+}\n\n/);
    expect(reply.capturedBody).toMatch(/event: end\ndata: \{[^}]+}\n\n/);
    expect(reply.capturedBody).toMatch(/"status":"done"/);
    expect(reply.ended).toBe(true);
  }, 30_000);

  it('4) cross-tenant id (RLS-driven NotFound) → `gone` event', async () => {
    const ctrl = new ImportsController(new ImportsService());
    const jobId = await createJob(org);
    await setStatus(jobId, 'done');
    const reply = makeReply();

    await ctrl.stream(fakeUser(orgB), jobId, makeReq(), reply as unknown as FastifyReply);

    expect(reply.capturedBody).toMatch(/event: gone\ndata: \{[^}]+}\n\n/);
    expect(reply.capturedBody).not.toMatch(/"status":"done"/);
    expect(reply.ended).toBe(true);
  }, 30_000);

  it('5) post-headers-sent service throw → emits `event: end, status: failed` (M2 contract)', async () => {
    // Construct an ImportsService whose streamProgress throws AFTER
    // the controller's writeHead/write(':stream-open') have already
    // committed the 200 status code. The M2 audit-pass fix says the
    // controller MUST catch and emit a generic end frame rather than
    // letting the exception propagate (post-headers, Nest's filter
    // can't transform it).
    const brokenService = {
      streamProgress: async () => {
        throw new Error('synthetic post-headers failure');
      },
    } as unknown as ImportsService;

    const ctrl = new ImportsController(brokenService);
    const jobId = await createJob(org);
    const reply = makeReply();

    await ctrl.stream(fakeUser(org), jobId, makeReq(), reply as unknown as FastifyReply);

    // Headers were already committed before the throw.
    expect(reply.capturedStatus).toBe(200);
    // The catch block emitted a clean end frame.
    expect(reply.capturedBody).toMatch(/event: end\ndata: \{[^}]+}\n\n/);
    expect(reply.capturedBody).toMatch(/"status":"failed"/);
    // And the controller still closed the socket cleanly.
    expect(reply.ended).toBe(true);
  }, 30_000);

  it('6) req.raw `close` event fires AbortController and ends the stream', async () => {
    const ctrl = new ImportsController(new ImportsService());
    const jobId = await createJob(org); // status='queued' — non-terminal
    const reply = makeReply();
    const req = makeReq();

    // Fire the stream and disconnect after a small delay. The
    // controller's req.raw.on('close') listener must fire the
    // AbortController; streamProgress's signal.aborted check then
    // exits the poll loop promptly (well under our 30s test budget).
    const streamPromise = ctrl.stream(fakeUser(org), jobId, req, reply as unknown as FastifyReply);

    // Give the loop one poll iteration (default 500ms), then disconnect.
    setTimeout(() => {
      (req.raw as unknown as EventEmitter).emit('close');
    }, 600);

    await streamPromise;
    expect(reply.ended).toBe(true);
    // Did NOT loop for the default 30-minute maxIterations (that
    // would time out the test, which would fail).
  }, 5000);
});
