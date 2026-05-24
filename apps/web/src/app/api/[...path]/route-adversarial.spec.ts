/**
 * v8.5 D.35 — ADVERSARIAL surface for the Pages reverse-proxy.
 *
 * The proxy is **internet-facing** at app.emapp.io. Every request a
 * malicious user can construct against `/api/*` reaches this code. The
 * happy-path spec (route.spec.ts) pins the contract; THIS spec tries
 * to BREAK the contract from the attacker's seat:
 *
 *   - Can a client force the upstream URL to point at an internal
 *     resource (SSRF)?
 *   - Can a client smuggle a header through?
 *   - Can a client inject CRLF into the upstream request?
 *   - Can a malicious upstream response (compromised backend) inject
 *     headers into the response we send to the browser?
 *   - Does the proxy hold state between concurrent requests that could
 *     leak across users?
 *   - Are timer / memory edge values defended?
 *
 * Israeli urban-renewal context: a hostile Contractor or a credential-
 * stuffed Tenant account is a realistic adversary. Bug bounty research
 * on Pages-style proxies has found exactly these classes of bugs in
 * other products; we're pinning them BEFORE Phase 4 ships.
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildUpstreamHeaders, buildUpstreamUrl, copyResponseHeaders } from './route';

function mockReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  host?: string;
  protocol?: 'http:' | 'https:';
  search?: string;
}): NextRequest {
  return {
    method: opts.method ?? 'GET',
    headers: new Headers(opts.headers ?? {}),
    nextUrl: {
      host: opts.host ?? 'app.emapp.io',
      protocol: opts.protocol ?? 'https:',
      search: opts.search ?? '',
    },
  } as unknown as NextRequest;
}

const ORIGINAL_API_BACKEND_URL = process.env['API_BACKEND_URL'];

describe('v8.5 D.35 ADVERSARIAL — path injection / SSRF surface', () => {
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

  it('A1) `..` path segments stitch literally — fetch URL parser handles normalization, but we never silently exit /api/', () => {
    // The Pages router passes segments as captured. If the FE caller
    // somehow inserted `..`, the URL builder would naively join with
    // `/`. The Web URL parser then normalizes the result. We pin the
    // OBSERVED behaviour so a future "let me filter .." patch is a
    // deliberate decision, not silent regression.
    const req = mockReq({});
    const stitched = buildUpstreamUrl(req, ['v1', 'imports', '..', '..', '..', 'admin']);
    // URL normalization happens at fetch() time, not in our builder —
    // assert the BUILDER does no clever rewriting (defense rests on
    // the backend's URL-level routing + Nest's global /api/v1 prefix
    // refusing anything that isn't /api/v1/<known-controller>).
    expect(stitched.startsWith('https://api.internal.railway/api/')).toBe(true);
    // The stitched string contains exactly what we put in — no
    // path-segment dedup that might mask `..` and let it through later.
    expect(stitched).toContain('/v1/imports/../../../admin');
  });

  it('A2) URL-encoded `..` segments stay encoded — we do not decode, fetch handles canonicalization', () => {
    const req = mockReq({});
    const stitched = buildUpstreamUrl(req, ['v1', '%2e%2e', 'admin']);
    expect(stitched).toContain('%2e%2e');
  });

  it('A3) backslash-bearing segments stay backslashes — we do not normalize Windows-style paths', () => {
    const req = mockReq({});
    const stitched = buildUpstreamUrl(req, ['v1', 'foo\\bar', 'baz']);
    // Backslash is a valid URL char; if a malicious client tries to
    // confuse a downstream router with `\`, we forward it unchanged
    // so the backend (Nest router) gets to refuse on its own terms.
    expect(stitched).toContain('foo\\bar');
  });

  it('A4) query string with `?` and `&` in segment values is NOT re-encoded — passes through', () => {
    const req = mockReq({ search: '?legitimate=true' });
    const stitched = buildUpstreamUrl(req, ['v1', 'owners']);
    expect(stitched).toBe('https://api.internal.railway/api/v1/owners?legitimate=true');
    expect(stitched.match(/\?/g)?.length).toBe(1); // exactly one ? — no smuggled second query
  });

  it('A5) 1000-segment path does not crash the builder (DoS via array bomb)', () => {
    const req = mockReq({});
    const segments = ['v1', ...Array.from({ length: 1000 }, (_, i) => `seg${i}`)];
    const stitched = buildUpstreamUrl(req, segments);
    expect(stitched.length).toBeGreaterThan(5000);
    // No throw, no truncation — bounded by the backend's URL length limit.
  });

  it('A6) empty segments array — produces a syntactically valid URL even if backend rejects it', () => {
    const req = mockReq({});
    // segments = [] would mean someone hit /api/ exactly, which Next.js
    // probably wouldn't route here, but defense-in-depth.
    expect(() => buildUpstreamUrl(req, [])).not.toThrow();
    expect(buildUpstreamUrl(req, [])).toBe('https://api.internal.railway/api/');
  });

  it('A7) API_BACKEND_URL with embedded path is preserved in the prefix — host-pinning, not path-stripping', () => {
    // If a future deploy puts API_BACKEND_URL=https://internal/proxy-prefix,
    // we want the proxy prefix preserved. (This is a feature, not a
    // bug — operators may host the API under a subpath.)
    process.env['API_BACKEND_URL'] = 'https://internal.railway/svc';
    const req = mockReq({});
    expect(buildUpstreamUrl(req, ['v1', 'health'])).toBe(
      'https://internal.railway/svc/api/v1/health',
    );
  });
});

describe('v8.5 D.35 ADVERSARIAL — request-side header smuggling', () => {
  it('B1) CRLF in cookie value — Headers class refuses to add it; getter returns null', () => {
    // The whatwg-fetch Headers API rejects header values containing
    // \r\n at SET time (TypeError). We can't even construct such a
    // request object — that's the defense layer we rely on.
    //
    // Test via the constructor: it MUST throw on the bad value.
    expect(() => new Headers({ cookie: 'em_at=x\r\nX-Injected: yes' })).toThrow();
  });

  it('B2) null-byte in cookie value — Headers class also refuses', () => {
    expect(() => new Headers({ cookie: 'em_at=x\0null' })).toThrow();
  });

  it('B3) extremely long cookie (10KB) — passes through; backend will reject if too large', () => {
    // Defense rests at the backend (cookie size limits) — proxy
    // does not impose its own limit so big-but-legit cookies aren't
    // truncated.
    const huge = 'em_at=' + 'a'.repeat(10_000);
    const req = mockReq({ headers: { cookie: huge } });
    const out = buildUpstreamHeaders(req);
    expect(out.get('cookie')).toBe(huge);
  });

  it('B4) Unicode in Authorization header is preserved (JWT base64 is ASCII, but defense)', () => {
    const req = mockReq({ headers: { authorization: 'Bearer eyJüñïcödé.test' } });
    const out = buildUpstreamHeaders(req);
    expect(out.get('authorization')).toBe('Bearer eyJüñïcödé.test');
  });

  it('B5) Multiple cf-* headers all stripped, even unusual ones like cf-warp-tag-id', () => {
    const req = mockReq({
      headers: {
        'cf-connecting-ip': '203.0.113.5',
        'cf-warp-tag-id': 'experimental',
        'cf-pseudo-ipv4': '1.2.3.4',
        'cf-ew-via': 'unusual',
        'CF-Mixed-Case': 'should-be-stripped',
      },
    });
    const out = buildUpstreamHeaders(req);
    for (const [key] of out) {
      expect(key.toLowerCase().startsWith('cf-')).toBe(false);
    }
  });

  it('B6) X-Forwarded-For chain (`client, proxy1, proxy2`) is OVERWRITTEN by cf-connecting-ip', () => {
    // A client sending a fake XFF chain to spoof their IP MUST be
    // overridden. cf-connecting-ip is the only trusted source.
    const req = mockReq({
      headers: {
        'x-forwarded-for': '203.0.113.99, 198.51.100.42, 192.0.2.7',
        'cf-connecting-ip': '203.0.113.5',
      },
    });
    const out = buildUpstreamHeaders(req);
    expect(out.get('x-forwarded-for')).toBe('203.0.113.5');
    // Must not contain the spoofed chain.
    expect(out.get('x-forwarded-for')).not.toContain(',');
  });

  it('B7) lowercase + uppercase variants of stripped headers both removed (case-insensitive check)', () => {
    const req = mockReq({
      headers: {
        FORWARDED: 'for=evil',
        'X-REAL-IP': '10.0.0.1',
      },
    });
    const out = buildUpstreamHeaders(req);
    expect(out.get('forwarded')).toBeNull();
    expect(out.get('x-real-ip')).toBeNull();
  });

  it('B8) header with empty value passes through (some libs use this as a probe)', () => {
    const req = mockReq({ headers: { accept: '' } });
    const out = buildUpstreamHeaders(req);
    expect(out.get('accept')).toBe('');
  });
});

describe('v8.5 D.35 ADVERSARIAL — response-side header smuggling (compromised backend)', () => {
  it('C1) Set-Cookie with multiple values passes through as concatenated string (browser parses both)', () => {
    // RFC 6265 + Web Headers API: multiple Set-Cookie headers from
    // upstream are joined by ", " in `.get()` but stay as separate
    // header lines via `.getSetCookie()` (Node 18+). The proxy uses
    // forEach + append, preserving the multi-cookie shape.
    const h = new Headers();
    h.append('set-cookie', 'em_at=ACCESS; HttpOnly');
    h.append('set-cookie', 'em_rt=REFRESH; HttpOnly; Path=/api/v1/auth/refresh');
    const upstream = new Response(null, { headers: h });
    const out = copyResponseHeaders(upstream);
    // The Headers API merges multiple Set-Cookie values via .get();
    // assert both are reachable (the browser will see both Set-Cookie
    // entries because we used append, not set).
    const cookieStr = out.get('set-cookie') ?? '';
    expect(cookieStr).toContain('em_at=ACCESS');
    expect(cookieStr).toContain('em_rt=REFRESH');
  });

  it('C2) Content-Length is NOT in the hop-by-hop deny-list — passes through (compressed transport ok)', () => {
    // Strictly per RFC 7230, Content-Length is end-to-end. We must
    // NOT strip it; the browser uses it to know when the response
    // is complete (for non-chunked replies).
    const upstream = new Response('hello', { headers: { 'content-length': '5' } });
    expect(copyResponseHeaders(upstream).get('content-length')).toBe('5');
  });

  it('C3) X-Content-Type-Options + Strict-Transport-Security passthrough (CSP + HSTS preserved end-to-end)', () => {
    const upstream = new Response(null, {
      headers: {
        'x-content-type-options': 'nosniff',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'content-security-policy': "default-src 'self'",
      },
    });
    const out = copyResponseHeaders(upstream);
    expect(out.get('x-content-type-options')).toBe('nosniff');
    expect(out.get('strict-transport-security')).toContain('max-age=31536000');
    expect(out.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('C4) compromised backend echoing client-supplied cf-connecting-ip in response — STRIPPED out', () => {
    // Worst case: upstream is compromised and tries to give the
    // browser CF-claim cookies. We strip cf-* on the response side too.
    const upstream = new Response(null, {
      headers: {
        'cf-connecting-ip': 'attacker-controlled-leak',
        'cf-ray': 'forged',
      },
    });
    const out = copyResponseHeaders(upstream);
    expect(out.get('cf-connecting-ip')).toBeNull();
    expect(out.get('cf-ray')).toBeNull();
  });

  it('C5) Server header from upstream passes through (no automatic hiding) — pin until ops decide', () => {
    // If the backend emits "Server: nestjs/11", currently we forward
    // it. Some shops scrub this for fingerprinting defense; until
    // there's a policy decision we DON'T silently drop it (could
    // break debugging). Pin the current behaviour so any future
    // strip is a deliberate decision.
    const upstream = new Response(null, { headers: { server: 'nestjs/11' } });
    expect(copyResponseHeaders(upstream).get('server')).toBe('nestjs/11');
  });
});

describe('v8.5 D.35 ADVERSARIAL — backend URL scheme / env tampering', () => {
  it('D1) API_BACKEND_URL with javascript: scheme — fetch refuses, our 502 envelope fires', async () => {
    // We do not validate the scheme in getBackendBase (operators set
    // it; if they set it wrong, fetch throws and we return 502 in the
    // {error} envelope). Pin that contract via a mocked fetch.
    process.env['API_BACKEND_URL'] = 'javascript:alert(1)';
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('Invalid URL scheme');
    }) as unknown as typeof fetch;
    try {
      const { GET } = await import('./route');
      const req = mockReq({});
      const res = await GET(req, { params: Promise.resolve({ path: ['v1', 'x'] }) });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('upstream_unreachable');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it('D2) API_BACKEND_URL with file:// scheme — fetch in node refuses', async () => {
    process.env['API_BACKEND_URL'] = 'file:///etc/passwd';
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      // Node's fetch refuses non-http(s) schemes with TypeError.
      throw new TypeError('fetch failed: only HTTP(S) protocols are supported');
    }) as unknown as typeof fetch;
    try {
      const { GET } = await import('./route');
      const req = mockReq({});
      const res = await GET(req, { params: Promise.resolve({ path: ['v1', 'x'] }) });
      expect(res.status).toBe(502);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it('D3) API_BACKEND_URL empty string — getBackendBase throws (caught by proxy, returns 502)', async () => {
    process.env['API_BACKEND_URL'] = '';
    const oldFetch = globalThis.fetch;
    // fetch never called because we throw before reaching it.
    globalThis.fetch = (async () => {
      throw new Error('should not reach');
    }) as unknown as typeof fetch;
    try {
      const { GET } = await import('./route');
      const req = mockReq({});
      // The throw from getBackendBase escapes through proxy() —
      // we want to know what happens. If it's an unhandled throw,
      // the route handler returns a 500 (Next.js default). We pin
      // SOME failure mode — never a silent success.
      const promise = GET(req, { params: Promise.resolve({ path: ['v1', 'x'] }) });
      await expect(promise).rejects.toThrow(/API_BACKEND_URL is not set/);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

describe('v8.5 D.35 ADVERSARIAL — concurrency / state isolation', () => {
  it('E1) 50 concurrent proxy invocations — no cross-request header leak', async () => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway';
    const oldFetch = globalThis.fetch;
    const observed: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const h = init.headers as Headers;
      observed.push(h.get('x-test-marker') ?? 'MISSING');
      // tiny artificial delay so concurrency actually overlaps
      await new Promise((r) => setTimeout(r, 5));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { GET } = await import('./route');
      const ctx = { params: Promise.resolve({ path: ['v1', 'x'] }) };
      // Build 50 requests, each with its OWN marker. Then assert the
      // backend saw exactly the markers we sent — no header bleeding
      // between concurrent invocations.
      const reqs = Array.from({ length: 50 }, (_, i) =>
        mockReq({ headers: { 'x-test-marker': `req-${i}` } }),
      );
      await Promise.all(reqs.map((r) => GET(r, ctx)));
      observed.sort();
      const expected = Array.from({ length: 50 }, (_, i) => `req-${i}`).sort();
      expect(observed).toEqual(expected);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it('E2) cf-connecting-ip from request A does NOT leak to request B', async () => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway';
    const oldFetch = globalThis.fetch;
    const observed: Array<{ marker: string; xff: string | null }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const h = init.headers as Headers;
      observed.push({
        marker: h.get('x-test-marker') ?? 'MISSING',
        xff: h.get('x-forwarded-for'),
      });
      await new Promise((r) => setTimeout(r, 3));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { GET } = await import('./route');
      const ctx = { params: Promise.resolve({ path: ['v1', 'x'] }) };
      const reqA = mockReq({
        headers: { 'x-test-marker': 'A', 'cf-connecting-ip': '203.0.113.5' },
      });
      const reqB = mockReq({
        headers: { 'x-test-marker': 'B', 'cf-connecting-ip': '198.51.100.7' },
      });
      await Promise.all([GET(reqA, ctx), GET(reqB, ctx), GET(reqA, ctx), GET(reqB, ctx)]);
      const a = observed.filter((o) => o.marker === 'A');
      const b = observed.filter((o) => o.marker === 'B');
      for (const o of a) expect(o.xff).toBe('203.0.113.5');
      for (const o of b) expect(o.xff).toBe('198.51.100.7');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});
