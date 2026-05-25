/**
 * v8.5 D.35 — pins the Pages Function reverse-proxy contract.
 *
 * The proxy at apps/web/src/app/api/[...path]/route.ts forwards
 * /api/v1/* from app.emapp.io to the private Railway API. Every
 * deviation has security or auth consequences:
 *
 *   - Forwarding a CF-internal header lets a backend trust client-
 *     supplied geo / WAF claims → bypass.
 *   - Dropping Set-Cookie on the response breaks the refresh-token
 *     rotation flow → users get logged out after 15 min.
 *   - Forwarding the original Host header lets a future SNI-based
 *     backend dispatch route the wrong way.
 *   - Following redirects auto-magically lets the backend bounce
 *     the proxy at attacker-controlled URLs with cookies attached.
 *
 * These tests pin each invariant. They use bare Web Standard
 * Headers / Request / Response objects (no NextRequest stubbing —
 * NextRequest is a thin subclass and the helpers we test only
 * touch the parts that already exist on the standard interface).
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  copyResponseHeaders,
  getBackendBase,
} from './route';

/** Build a minimal NextRequest-shaped object — only the surface the
 *  helpers actually read. */
function mockReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  host?: string;
  protocol?: 'http:' | 'https:';
  search?: string;
  body?: string;
}): NextRequest {
  const headers = new Headers(opts.headers ?? {});
  // §P0-1 — proxy now calls req.arrayBuffer() (body-buffering fix).
  // Mock must implement it so tests don't throw "req.arrayBuffer is not
  // a function". Returns empty buffer if no body is specified.
  const bodyBytes = opts.body ? new TextEncoder().encode(opts.body).buffer : new ArrayBuffer(0);
  return {
    method: opts.method ?? 'GET',
    headers,
    nextUrl: {
      host: opts.host ?? 'app.emapp.io',
      protocol: opts.protocol ?? 'https:',
      search: opts.search ?? '',
    },
    arrayBuffer: async () => bodyBytes,
  } as unknown as NextRequest;
}

const ORIGINAL_API_BACKEND_URL = process.env['API_BACKEND_URL'];

describe('v8.5 D.35 proxy — getBackendBase', () => {
  beforeEach(() => {
    delete process.env['API_BACKEND_URL'];
  });
  afterEach(() => {
    if (ORIGINAL_API_BACKEND_URL === undefined) {
      delete process.env['API_BACKEND_URL'];
    } else {
      process.env['API_BACKEND_URL'] = ORIGINAL_API_BACKEND_URL;
    }
  });

  it('1) missing env → throws "API_BACKEND_URL is not set"', () => {
    expect(() => getBackendBase()).toThrow(/API_BACKEND_URL is not set/);
  });

  it('2) strips trailing slash so concatenation never yields //', () => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway/';
    expect(getBackendBase()).toBe('https://api.internal.railway');
  });

  it('3) preserves the URL unchanged when no trailing slash', () => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway';
    expect(getBackendBase()).toBe('https://api.internal.railway');
  });
});

describe('v8.5 D.35 proxy — buildUpstreamUrl', () => {
  beforeEach(() => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway';
  });
  afterEach(() => {
    if (ORIGINAL_API_BACKEND_URL === undefined) {
      delete process.env['API_BACKEND_URL'];
    } else {
      process.env['API_BACKEND_URL'] = ORIGINAL_API_BACKEND_URL;
    }
  });

  it('4) builds /api/v1/<thing> from segments captured by [...path]', () => {
    const req = mockReq({});
    expect(buildUpstreamUrl(req, ['v1', 'owners'])).toBe(
      'https://api.internal.railway/api/v1/owners',
    );
  });

  it('5) appends the query string verbatim (preserves leading ?)', () => {
    const req = mockReq({ search: '?cursor=abc&limit=20' });
    expect(buildUpstreamUrl(req, ['v1', 'owners'])).toBe(
      'https://api.internal.railway/api/v1/owners?cursor=abc&limit=20',
    );
  });

  it('6) nested paths join with / (no double-slash)', () => {
    const req = mockReq({});
    expect(buildUpstreamUrl(req, ['v1', 'imports', 'abc-123', 'stream'])).toBe(
      'https://api.internal.railway/api/v1/imports/abc-123/stream',
    );
  });
});

describe('v8.5 D.35 proxy — buildUpstreamHeaders (request header rebuild)', () => {
  it('7) strips Host header (we rewrite to the backend host via fetch URL)', () => {
    const req = mockReq({ headers: { host: 'app.emapp.io', accept: 'application/json' } });
    const out = buildUpstreamHeaders(req);
    expect(out.get('host')).toBeNull();
    expect(out.get('accept')).toBe('application/json');
  });

  it('8) strips ALL cf-* headers (CF internal — backend MUST NOT trust client-supplied CF claims)', () => {
    const req = mockReq({
      headers: {
        'cf-connecting-ip': '203.0.113.5',
        'cf-ipcountry': 'IL',
        'cf-ray': 'abc',
        'cf-visitor': '{"scheme":"https"}',
        'cf-warp-tag-id': 'leak-attempt',
      },
    });
    const out = buildUpstreamHeaders(req);
    // None of the cf-* headers may pass through.
    for (const [key] of out) {
      expect(key.toLowerCase().startsWith('cf-')).toBe(false);
    }
  });

  it('9) rebuilds x-forwarded-for from cf-connecting-ip (the only IP CF guarantees)', () => {
    const req = mockReq({
      headers: { 'cf-connecting-ip': '203.0.113.5' },
    });
    const out = buildUpstreamHeaders(req);
    expect(out.get('x-forwarded-for')).toBe('203.0.113.5');
    expect(out.get('x-real-ip')).toBe('203.0.113.5');
  });

  it('10) does NOT trust a client-supplied x-forwarded-for when cf-connecting-ip is present', () => {
    const req = mockReq({
      headers: {
        'x-forwarded-for': '10.0.0.1, 192.0.2.99',
        'cf-connecting-ip': '203.0.113.5',
      },
    });
    const out = buildUpstreamHeaders(req);
    // CF-Connecting-IP wins; the client-supplied X-Forwarded-For is overwritten.
    expect(out.get('x-forwarded-for')).toBe('203.0.113.5');
  });

  it('11) falls back to x-forwarded-for when cf-connecting-ip absent (local dev / non-CF path)', () => {
    const req = mockReq({
      headers: { 'x-forwarded-for': '198.51.100.10' },
    });
    const out = buildUpstreamHeaders(req);
    expect(out.get('x-forwarded-for')).toBe('198.51.100.10');
    expect(out.get('x-real-ip')).toBe('198.51.100.10');
  });

  it('12) NO ip header is emitted when neither cf-connecting-ip nor x-forwarded-for present', () => {
    const req = mockReq({ headers: { accept: 'application/json' } });
    const out = buildUpstreamHeaders(req);
    expect(out.get('x-forwarded-for')).toBeNull();
    expect(out.get('x-real-ip')).toBeNull();
  });

  it('13) sets x-forwarded-host to req.nextUrl.host (so backend logs the public host)', () => {
    const req = mockReq({ host: 'app.emapp.io' });
    const out = buildUpstreamHeaders(req);
    expect(out.get('x-forwarded-host')).toBe('app.emapp.io');
  });

  it('14) sets x-forwarded-proto from req.nextUrl.protocol (with the colon stripped)', () => {
    const reqHttps = mockReq({ protocol: 'https:' });
    expect(buildUpstreamHeaders(reqHttps).get('x-forwarded-proto')).toBe('https');
    const reqHttp = mockReq({ protocol: 'http:' });
    expect(buildUpstreamHeaders(reqHttp).get('x-forwarded-proto')).toBe('http');
  });

  it('15) preserves Cookie header verbatim (this is how session JWTs reach the backend)', () => {
    const cookie = 'em_at=ACCESS_JWT; em_rt=REFRESH_JWT; em_sid=SESSION_ID';
    const req = mockReq({ headers: { cookie } });
    expect(buildUpstreamHeaders(req).get('cookie')).toBe(cookie);
  });

  it('16) preserves Authorization header verbatim (Provider Admin path uses header bearer)', () => {
    const auth = 'Bearer eyJhbGciOiJIUzI1NiJ9.PROVIDER_ADMIN_JWT.sig';
    const req = mockReq({ headers: { authorization: auth } });
    expect(buildUpstreamHeaders(req).get('authorization')).toBe(auth);
  });

  it('17) overrides any client-supplied x-forwarded-host (defense — clients cannot fake the public host)', () => {
    const req = mockReq({
      host: 'app.emapp.io',
      headers: { 'x-forwarded-host': 'attacker.example' },
    });
    expect(buildUpstreamHeaders(req).get('x-forwarded-host')).toBe('app.emapp.io');
  });

  it('18) overrides any client-supplied x-forwarded-proto', () => {
    const req = mockReq({
      protocol: 'https:',
      headers: { 'x-forwarded-proto': 'http' },
    });
    expect(buildUpstreamHeaders(req).get('x-forwarded-proto')).toBe('https');
  });

  it('19) strips client-supplied Forwarded (RFC 7239) and X-Real-IP — same defense class', () => {
    const req = mockReq({
      headers: {
        forwarded: 'for=192.0.2.43;by=evil',
        'x-real-ip': '10.0.0.1',
      },
    });
    const out = buildUpstreamHeaders(req);
    expect(out.get('forwarded')).toBeNull();
    // x-real-ip would be re-added if any IP source was present, but
    // there's neither cf-connecting-ip nor x-forwarded-for here, so
    // it stays absent (the client value MUST NOT be passed through).
    expect(out.get('x-real-ip')).toBeNull();
  });
});

describe('v8.5 D.35 proxy — copyResponseHeaders (response back to browser)', () => {
  it('20) preserves Set-Cookie (refresh-token rotation depends on this)', () => {
    const upstream = new Response(null, {
      headers: { 'set-cookie': 'em_rt=NEW_REFRESH; HttpOnly; Secure; SameSite=Lax; Path=/' },
    });
    const out = copyResponseHeaders(upstream);
    expect(out.get('set-cookie')).toContain('em_rt=NEW_REFRESH');
  });

  it('21) preserves Content-Type', () => {
    const upstream = new Response(null, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(copyResponseHeaders(upstream).get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
  });

  it('22) strips hop-by-hop headers (RFC 7230 §6.1)', () => {
    const upstream = new Response(null, {
      headers: {
        connection: 'close',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'proxy-authenticate': 'Basic',
        upgrade: 'h2c',
      },
    });
    const out = copyResponseHeaders(upstream);
    expect(out.get('connection')).toBeNull();
    expect(out.get('keep-alive')).toBeNull();
    expect(out.get('transfer-encoding')).toBeNull();
    expect(out.get('proxy-authenticate')).toBeNull();
    expect(out.get('upgrade')).toBeNull();
  });

  it('23) strips CF-internal response headers (browser has no business knowing edge POP)', () => {
    const upstream = new Response(null, {
      headers: {
        'cf-connecting-ip': '203.0.113.5',
        'cf-ray': 'abc',
        'cf-ipcountry': 'IL',
        'cf-visitor': '{"scheme":"https"}',
      },
    });
    const out = copyResponseHeaders(upstream);
    for (const [key] of out) {
      expect(key.toLowerCase().startsWith('cf-')).toBe(false);
    }
  });

  it('24) preserves Cache-Control + X-Accel-Buffering (SSE relies on the latter)', () => {
    const upstream = new Response(null, {
      headers: {
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      },
    });
    const out = copyResponseHeaders(upstream);
    expect(out.get('cache-control')).toBe('no-cache');
    expect(out.get('x-accel-buffering')).toBe('no');
  });
});

describe('v8.5 D.35 proxy — full end-to-end with mocked fetch (integration)', () => {
  const origBase = process.env['API_BACKEND_URL'];
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway';
  });
  afterEach(() => {
    if (origBase === undefined) {
      delete process.env['API_BACKEND_URL'];
    } else {
      process.env['API_BACKEND_URL'] = origBase;
    }
    globalThis.fetch = origFetch;
  });

  it('25) POST handler: buffers body as ArrayBuffer (no duplex:half), redirect:manual', async () => {
    // §P0-1 closure pin — the proxy MUST buffer body to ArrayBuffer.
    // The old code used `req.body` (ReadableStream) + `duplex:'half'`.
    // That caused a race: undici closed the connection before the proxy
    // finished writing when upstream rejected fast (argon2 not reached).
    // Fix: req.arrayBuffer() → full buffer in memory → no duplex option.
    let captured: { url: string; init: RequestInit & { duplex?: string } } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit & { duplex?: string }) => {
      captured = { url, init };
      return new Response('{"data":{"ok":true}}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { POST } = await import('./route');
    const req = mockReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'em_at=x' },
      body: JSON.stringify({ email: 'u@x.com', password: 'pw' }),
    });
    const ctx = { params: Promise.resolve({ path: ['v1', 'imports'] }) };
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://api.internal.railway/api/v1/imports');
    expect(captured!.init.method).toBe('POST');
    expect(captured!.init.redirect).toBe('manual');
    // THE KEY ASSERTION: duplex must NOT be set (body is a buffer, not a stream).
    expect(captured!.init.duplex).toBeUndefined();
    // Body must be an ArrayBuffer, not a ReadableStream.
    expect(captured!.init.body).toBeInstanceOf(ArrayBuffer);
    // Cookie passes through.
    const fwd = captured!.init.headers as Headers;
    expect(fwd.get('cookie')).toBe('em_at=x');
  });

  it('26) GET handler: NO body, NO duplex (sending body on GET is a fetch spec violation)', async () => {
    let captured: { init: RequestInit & { duplex?: 'half'; body?: unknown } } | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit & { duplex?: 'half' }) => {
      captured = { init };
      return new Response('{"data":[]}', { status: 200 });
    }) as unknown as typeof fetch;

    const { GET } = await import('./route');
    const req = mockReq({ method: 'GET' });
    const res = await GET(req, { params: Promise.resolve({ path: ['v1', 'owners'] }) });
    expect(res.status).toBe(200);
    expect(captured!.init.duplex).toBeUndefined();
    expect(captured!.init.body).toBeUndefined();
  });

  it('27) network failure → 502 with {error.code:"upstream_unreachable"} envelope (D.16)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { GET } = await import('./route');
    const req = mockReq({ method: 'GET' });
    const res = await GET(req, { params: Promise.resolve({ path: ['v1', 'health'] }) });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('upstream_unreachable');
  });

  it('28) Set-Cookie from upstream reaches the response (refresh-token rotation works through the proxy)', async () => {
    globalThis.fetch = (async () => {
      return new Response('{}', {
        status: 200,
        headers: {
          'set-cookie': 'em_rt=ROTATED; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth/refresh',
        },
      });
    }) as unknown as typeof fetch;

    const { POST } = await import('./route');
    const req = mockReq({ method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ path: ['v1', 'auth', 'refresh'] }) });
    expect(res.headers.get('set-cookie')).toContain('em_rt=ROTATED');
  });

  it('29) all verbs are wired and route through the same proxy', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(init.method ?? 'UNKNOWN');
      return new Response('{}', { status: 204 });
    }) as unknown as typeof fetch;

    const route = await import('./route');
    const ctx = { params: Promise.resolve({ path: ['v1', 'x'] }) };
    for (const verb of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const) {
      const handler = (
        route as unknown as Record<string, (r: NextRequest, c: typeof ctx) => Promise<Response>>
      )[verb];
      expect(handler).toBeDefined();
      // eslint-disable-next-line no-await-in-loop
      await handler!(mockReq({ method: verb }), ctx);
    }
    expect(calls).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  });
});

// suppress unused-import lint when vi.mock isn't used (we don't need it).
void vi;
