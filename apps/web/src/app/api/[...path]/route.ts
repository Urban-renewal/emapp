/**
 * Same-origin reverse proxy → backend API.
 *
 * v8.5 D.35 — Option A topology.
 *
 *   Browser  ───────►  app.emapp.io/api/v1/*  (Cloudflare Pages)
 *                          │
 *                          │  THIS ROUTE HANDLER
 *                          ▼
 *                     Cloudflare WAF / DDoS
 *                          │
 *                          ▼
 *                    Railway @emapp/api  (private, no public DNS)
 *
 *   Net win:
 *     1. Cookies are hostOnly on app.emapp.io — no Domain attribute
 *        leak (matches apps/api/src/modules/auth/auth.service.ts
 *        COOKIE_BASE which omits Domain). Frontend and API share the
 *        same registrable domain in the browser's eyes ⇒ no CORS,
 *        no SameSite=None complications, no subdomain takeover of
 *        api.emapp.io.
 *     2. Cloudflare reverse proxy gives us WAF + Bot Management +
 *        Argo routing for free.
 *     3. Backend doesn't need to be on the public internet —
 *        Railway internal URL only; the only public ingress is
 *        Pages (which has its own DDoS shield).
 *
 *   What we forward:
 *     - method, path (everything after /api/), query string
 *     - body (passthrough; Next.js Edge Runtime streams it)
 *     - Cookie header (the session JWTs)
 *     - Content-Type, Accept, Accept-Language, User-Agent
 *     - X-Forwarded-For (CF-Connecting-IP → set by Cloudflare)
 *     - Authorization (for Provider Admin paths that use header bearer)
 *
 *   What we strip (Critical — defense in depth):
 *     - Host header (we rewrite to the backend's expected host)
 *     - Forwarded / X-Real-IP (we mint our own from CF-Connecting-IP)
 *     - Any header beginning with `cf-` (Cloudflare internal — leaking
 *       these would let the backend trust client-supplied CF claims)
 *
 *   What we set on the upstream request:
 *     - X-Forwarded-Host: app.emapp.io (so backend logs the public host)
 *     - X-Forwarded-Proto: https
 *     - X-Forwarded-For: CF-Connecting-IP (real client IP from CF)
 *     - X-Real-IP: same
 *
 *   What we pass back to the browser:
 *     - Status code, status text
 *     - All response headers EXCEPT hop-by-hop (RFC 7230 §6.1)
 *     - Set-Cookie (critical — that's how the auth flow writes
 *       refresh-token rotation back to the browser)
 *     - Body (streamed)
 *
 *   Env:
 *     API_BACKEND_URL  — the private Railway URL (e.g.
 *                        https://emapp-api.railway.internal). MUST be
 *                        set in Cloudflare Pages env, NOT exposed
 *                        via NEXT_PUBLIC_*.
 *
 *   This handler is intentionally Edge-incompatible (Node runtime) —
 *   the Pages Functions adapter (@cloudflare/next-on-pages) emits a
 *   workerd-compatible bundle that runs at the CDN edge, but we use
 *   Node-style streaming for simplicity here. If we ever flip to the
 *   Edge runtime, replace ReadableStream usage with the Edge
 *   equivalents — the public contract stays identical.
 */
import { type NextRequest, NextResponse } from 'next/server';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // We strip CF-Connecting-IP from the response too — defense in
  // depth, the browser has no business knowing the edge POP'd IP.
  'cf-connecting-ip',
  'cf-ray',
  'cf-ipcountry',
  'cf-visitor',
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'forwarded',
  'x-real-ip',
  // We REMINT x-forwarded-* from CF claims; don't trust client values.
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  // Hop-by-hop + unsupported request headers (RFC 7230 §6.1). These
  // describe the CLIENT↔proxy connection, not the proxy↔upstream one,
  // and forwarding them breaks the upstream fetch:
  //   - `expect: 100-continue` — undici's fetch() THROWS
  //     `NotSupportedError: expect header not supported`, surfacing to
  //     the user as a 502 on EVERY POST/PUT/PATCH (login included).
  //     .NET/PowerShell clients add it by default; some browsers add it
  //     for larger bodies. We buffer the body and send it whole, so the
  //     100-continue handshake is meaningless here anyway.
  //   - `connection`/`keep-alive`/`transfer-encoding`/`upgrade`/`te`/
  //     `trailer` — per-hop; undici manages the upstream connection +
  //     framing itself (we send a fixed-length buffered body).
  //   - `proxy-*` — belong to the client↔proxy hop only.
  // Content-Length is intentionally NOT stripped: undici recomputes it
  // from the buffered body and the two agree.
  'expect',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
]);

/** v8.5 — exported for proxy.spec.ts.
 *  Spec MUST be able to assert "missing env throws"; keeping it
 *  module-scoped without an export would force the spec to invoke
 *  a full proxy() to surface the throw, which couples the test to
 *  too much shape. */
export function getBackendBase(): string {
  const url = process.env['API_BACKEND_URL'];
  if (!url) {
    // Fail loud — a misconfigured Pages deploy with no upstream is
    // a Sev1 incident, not a degraded mode.
    throw new Error('API_BACKEND_URL is not set — the Pages Function cannot route to the backend.');
  }
  return url.replace(/\/$/, '');
}

/** v8.5 — exported for proxy.spec.ts. */
export function buildUpstreamUrl(req: NextRequest, pathSegments: string[]): string {
  // pathSegments comes from the dynamic [...path] capture; we prepend
  // /api/v1 because the backend (NestJS global prefix per D.10) expects
  // it. The browser called /api/v1/<thing>; segments here are
  // ['v1', '<thing>', ...] — so we just stitch '/api/' + join('/').
  const path = `/api/${pathSegments.join('/')}`;
  const search = req.nextUrl.search; // includes the leading '?'
  return `${getBackendBase()}${path}${search}`;
}

/** v8.5 — exported for proxy.spec.ts. */
export function buildUpstreamHeaders(req: NextRequest): Headers {
  const out = new Headers();
  for (const [key, value] of req.headers) {
    const lower = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith('cf-')) continue; // CF internals stay at the edge
    out.set(key, value);
  }
  // Real client IP — CF-Connecting-IP is the only header CF guarantees
  // is the real public IP (X-Forwarded-For is appendable and can be
  // spoofed by clients before reaching CF).
  const realIp = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? '';
  if (realIp) {
    out.set('x-forwarded-for', realIp);
    out.set('x-real-ip', realIp);
  }
  out.set('x-forwarded-host', req.nextUrl.host);
  out.set('x-forwarded-proto', req.nextUrl.protocol.replace(':', ''));
  return out;
}

/** v8.5 — exported for proxy.spec.ts. */
export function copyResponseHeaders(upstream: Response): Headers {
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    out.append(key, value);
  });
  return out;
}

async function proxy(req: NextRequest, segments: string[]): Promise<Response> {
  const url = buildUpstreamUrl(req, segments);
  const headers = buildUpstreamHeaders(req);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: 'manual', // never auto-follow upstream redirects (would
    // re-issue with original Host and leak state)
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // §P0-1 closure (post-S11 manual smoke catch) — BUFFER the body
    // instead of streaming with `duplex: 'half'`.
    //
    // The streaming variant (`init.body = req.body; init.duplex = 'half'`)
    // has a deterministic failure mode against fast-rejecting upstream
    // endpoints (e.g. POST /auth/login with wrong password — the API
    // returns 401 before any DB hit, immediately closing its side of
    // the HTTP connection). Node 20.x undici sees the connection close
    // while the half-duplex stream is still mid-write and throws
    // `TypeError: fetch failed` → caught below as `upstream_unreachable`
    // → 502 surfaced to the user as "server not available", when the
    // real story is a valid 401.
    //
    // Buffering the body fixes this: undici sends the full body first,
    // THEN reads the response — the standard request/response cycle.
    // All proxy traffic is small JSON (R2 file uploads bypass the
    // proxy entirely via presigned URLs — they go browser → R2 direct,
    // not through this route handler), so buffering is cheap.
    //
    // Tradeoff: we lose the ability to stream multi-GB upload bodies
    // through this proxy. That's deliberate — the architecture says
    // large uploads ALWAYS go through R2 presigned URLs, NEVER
    // through the proxy. If a future endpoint needs request streaming
    // (rare — most APIs accept ≤1MB bodies), it would need a dedicated
    // route handler.
    const buffer = await req.arrayBuffer();
    // Empty body: don't set init.body at all (some upstreams treat
    // ArrayBuffer of length 0 differently from no body).
    if (buffer.byteLength > 0) {
      init.body = buffer;
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (e) {
    // Network-level failure — backend unreachable. Return a 502 in
    // the {error} envelope so the FE error handler is happy (D.16).
    //
    // §P0-1 — log the underlying error to server stderr so an
    // operator inspecting the Pages Function logs sees WHY the
    // upstream is unreachable (DNS? TLS? connect timeout? half-duplex
    // race?). The previous catch swallowed the error silently, which
    // is why the bug took manual smoke-testing to find.
    if (process.env['NODE_ENV'] !== 'test') {
      // eslint-disable-next-line no-console -- operator-facing debug log; never reaches the browser
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      console.error('[proxy] upstream fetch threw', {
        url,
        method: req.method,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        // The real reason lives in `.cause` (undici wraps everything as a
        // generic "fetch failed"). Surface it so ops sees DNS/TLS/connect/
        // unsupported-header failures without a repro.
        cause: cause ? (cause.code ?? cause.message ?? String(cause)) : undefined,
      });
    }
    return NextResponse.json(
      {
        error: {
          code: 'upstream_unreachable',
          message: 'API backend did not respond',
        },
      },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyResponseHeaders(upstream),
  });
}

type Ctx = { params: Promise<{ path: string[] }> };

async function segs(ctx: Ctx): Promise<string[]> {
  return (await ctx.params).path;
}

// One handler per verb — Next.js requires named exports.
export async function GET(req: NextRequest, ctx: Ctx) {
  return proxy(req, await segs(ctx));
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return proxy(req, await segs(ctx));
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return proxy(req, await segs(ctx));
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return proxy(req, await segs(ctx));
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return proxy(req, await segs(ctx));
}
export async function HEAD(req: NextRequest, ctx: Ctx) {
  return proxy(req, await segs(ctx));
}
export async function OPTIONS(req: NextRequest, ctx: Ctx) {
  return proxy(req, await segs(ctx));
}

// SSE / long-lived responses: Next.js streams Response.body — we
// already pass upstream.body through unchanged, which is a
// ReadableStream, so progress events flow back without buffering.
// (Cloudflare Pages Functions buffer responses by default; the
// `X-Accel-Buffering: no` header that the API SSE endpoint emits
// disables that. Verified in the SSE controller — apps/api/src/
// modules/imports/imports.controller.ts.)
