/**
 * §P0-1 closure pin — proxy body buffering.
 *
 * Manual smoke against the live API caught this: POST /api/v1/auth/login
 * with wrong password via the proxy returned 502 `upstream_unreachable`
 * 5/5 times, while the same payload sent directly to the API returned
 * 401 `invalid_credentials` as expected.
 *
 * Root cause: the proxy streamed `req.body` (a ReadableStream) with
 * `duplex: 'half'`. Node 20.x undici has a deterministic failure mode
 * when the upstream rejects fast (no DB hit, no argon2 verify — just
 * a credential mismatch reject): the upstream closes its side of the
 * connection BEFORE the proxy finishes writing the body, undici sees
 * the connection close and throws `TypeError: fetch failed`, which the
 * catch swallowed as 502.
 *
 * Fix: buffer the body to ArrayBuffer first. Single roundtrip:
 * proxy sends FULL body, then reads response. No half-duplex race.
 *
 * These tests pin the contract so a future "performance optimisation"
 * back to streaming would fail CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const ORIGINAL_API_BACKEND_URL = process.env['API_BACKEND_URL'];

function makeRequest(opts: {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}): import('next/server').NextRequest {
  const headers = new Headers({
    'content-type': 'application/json',
    ...opts.headers,
  });
  // Build a real Request — Next.js NextRequest extends Request so the
  // proxy's call to `req.arrayBuffer()` works on the standard surface.
  const req = new Request(opts.url, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body ?? '{"email":"u@x.com","password":"wrong"}',
  });
  // Augment with the bits proxy() reads (nextUrl). Cast through unknown
  // — we only touch the public surface.
  const augmented = Object.assign(req, {
    nextUrl: new URL(opts.url),
  });
  return augmented as unknown as import('next/server').NextRequest;
}

describe('§P0-1 — proxy body buffering (not streaming)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any = null;

  beforeEach(() => {
    process.env['API_BACKEND_URL'] = 'http://localhost:3000';
  });

  afterEach(() => {
    if (ORIGINAL_API_BACKEND_URL === undefined) {
      delete process.env['API_BACKEND_URL'];
    } else {
      process.env['API_BACKEND_URL'] = ORIGINAL_API_BACKEND_URL;
    }
    if (fetchSpy) {
      fetchSpy.mockRestore();
      fetchSpy = null;
    }
  });

  it('1) when upstream returns 401, proxy returns 401 (NOT 502 upstream_unreachable)', async () => {
    // Mock fetch to return a real 401 response with the D.16 envelope.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'invalid_credentials' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const req = makeRequest({
      url: 'https://app.emapp.io/api/v1/auth/login',
      body: JSON.stringify({ email: 'u@x.com', password: 'wrong' }),
    });
    const ctx = { params: Promise.resolve({ path: ['v1', 'auth', 'login'] }) };
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'invalid_credentials' } });
  });

  it('2) proxy passes the body to upstream as a BUFFER (not a stream) — no `duplex` option', async () => {
    let capturedInit: RequestInit | undefined;
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init;
        return new Response('{"data":{}}', { status: 200 });
      });
    const req = makeRequest({
      url: 'https://app.emapp.io/api/v1/auth/login',
      body: JSON.stringify({ email: 'u@x.com', password: 'wrong' }),
    });
    const ctx = { params: Promise.resolve({ path: ['v1', 'auth', 'login'] }) };
    await POST(req, ctx);

    // The fix: init.body is an ArrayBuffer / Uint8Array, NOT a
    // ReadableStream. `duplex` must NOT be set (it's only required
    // when body is a stream).
    expect(capturedInit).toBeDefined();
    expect((capturedInit as { duplex?: string }).duplex).toBeUndefined();
    // Body should be present and serialisable (Buffer / ArrayBuffer).
    expect(capturedInit?.body).toBeDefined();
    expect(capturedInit?.body).not.toBeInstanceOf(ReadableStream);
  });

  it('3) empty POST body → upstream receives no body (not an empty ArrayBuffer)', async () => {
    let capturedInit: RequestInit | undefined;
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
        capturedInit = init;
        return new Response('{"data":{}}', { status: 200 });
      });
    // POST with empty body — analogous to `/api/v1/imports/:id/start`
    // which takes no body but is a POST.
    const req = makeRequest({
      url: 'https://app.emapp.io/api/v1/imports/abc/start',
      body: '',
    });
    const ctx = { params: Promise.resolve({ path: ['v1', 'imports', 'abc', 'start'] }) };
    await POST(req, ctx);
    // body should be undefined (not an empty ArrayBuffer); some upstreams
    // treat an empty body slot differently and the prior code mirrored
    // the original undefined.
    expect(capturedInit?.body).toBeUndefined();
  });

  it('4) when upstream genuinely throws (network error), proxy returns 502 with D.16 envelope', async () => {
    // Real network failure (e.g. DNS NXDOMAIN, connection refused).
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    const req = makeRequest({
      url: 'https://app.emapp.io/api/v1/auth/login',
    });
    const ctx = { params: Promise.resolve({ path: ['v1', 'auth', 'login'] }) };
    const res = await POST(req, ctx);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'upstream_unreachable', message: 'API backend did not respond' },
    });
  });

  it('5) upstream 5xx is passed through (NOT remapped to 502)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'database_unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const req = makeRequest({
      url: 'https://app.emapp.io/api/v1/auth/login',
    });
    const ctx = { params: Promise.resolve({ path: ['v1', 'auth', 'login'] }) };
    const res = await POST(req, ctx);
    // 503 should reach the FE unchanged; only NETWORK failures map to 502.
    expect(res.status).toBe(503);
  });

  it('6) upstream 4xx response body is forwarded verbatim', async () => {
    const errPayload = {
      error: {
        code: 'validation_error',
        details: { password: ['too_short'] },
      },
    };
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(errPayload), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const req = makeRequest({
      url: 'https://app.emapp.io/api/v1/auth/login',
    });
    const ctx = { params: Promise.resolve({ path: ['v1', 'auth', 'login'] }) };
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(errPayload);
  });
});
