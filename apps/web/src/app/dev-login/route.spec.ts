/**
 * DEV-ONLY navigation-login route — security + behavior pins.
 *
 * This is an AUTH-ADJACENT, DEV-ONLY surface. The invariants below are the
 * reason it is safe:
 *
 *   - DOUBLE-GATED, FAILS CLOSED: 404 (notFound) unless
 *     NODE_ENV==='development' AND DEV_AUTH_BYPASS==='1'. Provably
 *     impossible to mint a session in production.
 *   - Role ALLOWLISTED: only manager|agent|viewer|managerBeta; anything
 *     else → 404. Default role is manager.
 *   - On success: 302 → /he (fixed target, no open-redirect) with the
 *     upstream Set-Cookie FORWARDED verbatim (incl. multiple cookies).
 *   - On API failure: 302 → /he/login with NO cookie (never 500-leak).
 *   - Creds are never in the URL; the password is a server-side constant.
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeDevNavLoginEnabled, GET } from './route';

// `notFound()` throws a Next.js sentinel in real usage. We mock it to a
// distinguishable throw so a test can assert "the gate refused".
const NOT_FOUND = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

function mockReq(opts: { role?: string | null; origin?: string }): NextRequest {
  const origin = opts.origin ?? 'http://localhost:3001';
  const params = new URLSearchParams();
  if (opts.role != null) params.set('role', opts.role);
  return {
    nextUrl: {
      origin,
      searchParams: params,
    },
  } as unknown as NextRequest;
}

function restore() {
  vi.unstubAllEnvs();
}

function enableDev() {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DEV_AUTH_BYPASS', '1');
  vi.stubEnv('API_BACKEND_URL', 'https://api.internal.railway');
}

describe('computeDevNavLoginEnabled — pure double-gate (mirrors API gate)', () => {
  it('true ONLY for development + flag "1"', () => {
    expect(computeDevNavLoginEnabled('development', '1')).toBe(true);
  });
  it('false when flag is not "1"', () => {
    expect(computeDevNavLoginEnabled('development', undefined)).toBe(false);
    expect(computeDevNavLoginEnabled('development', '0')).toBe(false);
    expect(computeDevNavLoginEnabled('development', 'true')).toBe(false);
  });
  it('false in non-development envs even with the flag (prod-impossibility)', () => {
    expect(computeDevNavLoginEnabled('production', '1')).toBe(false);
    expect(computeDevNavLoginEnabled('test', '1')).toBe(false);
    expect(computeDevNavLoginEnabled(undefined, '1')).toBe(false);
  });
});

describe('GET /dev-login — gating', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    restore();
    vi.unstubAllGlobals();
  });

  it('404s (notFound) when NODE_ENV !== development', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    await expect(GET(mockReq({}))).rejects.toBe(NOT_FOUND);
  });

  it('404s (notFound) when DEV_AUTH_BYPASS !== "1"', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DEV_AUTH_BYPASS', undefined);
    await expect(GET(mockReq({}))).rejects.toBe(NOT_FOUND);
  });

  it('404s (notFound) for an unknown role even when fully enabled', async () => {
    enableDev();
    await expect(GET(mockReq({ role: 'superadmin' }))).rejects.toBe(NOT_FOUND);
    await expect(GET(mockReq({ role: '' }))).rejects.toBe(NOT_FOUND);
    await expect(GET(mockReq({ role: 'manager; drop' }))).rejects.toBe(NOT_FOUND);
  });
});

describe('GET /dev-login — login + Set-Cookie forwarding', () => {
  afterEach(() => {
    restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forwards upstream Set-Cookie verbatim on a 302 → /he (success)', async () => {
    enableDev();
    const accessCookie = 'access_token=AAA; Path=/; HttpOnly; SameSite=Lax';
    const refreshCookie = 'refresh_token=RRR; Path=/api/v1/auth; HttpOnly; SameSite=Lax';
    const upstreamHeaders = new Headers();
    upstreamHeaders.append('set-cookie', accessCookie);
    upstreamHeaders.append('set-cookie', refreshCookie);

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // Password must be in the BODY, never the URL.
      const body = JSON.parse(String(init?.body));
      expect(body.email).toBe('manager@alpha.dev');
      expect(body.password).toBe('DevPassword123!');
      expect(String(_url)).not.toContain('DevPassword123!');
      return new Response(JSON.stringify({ data: { user: {} } }), {
        status: 200,
        headers: upstreamHeaders,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(mockReq({ role: 'manager' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3001/he');

    const cookies = res.headers.getSetCookie();
    expect(cookies).toContain(accessCookie);
    expect(cookies).toContain(refreshCookie);
    expect(cookies).toHaveLength(2);
  });

  it('defaults to the manager role when ?role is absent', async () => {
    enableDev();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.email).toBe('manager@alpha.dev');
      return new Response('{}', { status: 200, headers: new Headers() });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await GET(mockReq({}));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3001/he');
  });

  it('maps each allowlisted role to its seed email', async () => {
    enableDev();
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)).email);
      return new Response('{}', { status: 200, headers: new Headers() });
    });
    vi.stubGlobal('fetch', fetchMock);
    await GET(mockReq({ role: 'agent' }));
    await GET(mockReq({ role: 'viewer' }));
    await GET(mockReq({ role: 'managerBeta' }));
    expect(seen).toEqual(['agent@alpha.dev', 'viewer@alpha.dev', 'manager@beta.dev']);
  });

  it('redirects to /he/login with NO cookie when the API rejects (non-200)', async () => {
    enableDev();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'invalid_credentials' } }), {
          status: 401,
          headers: new Headers({ 'set-cookie': 'should_not=leak' }),
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await GET(mockReq({ role: 'manager' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3001/he/login');
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('redirects to /he/login (no cookie, no 500) when the backend is unreachable', async () => {
    enableDev();
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await GET(mockReq({ role: 'manager' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3001/he/login');
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});
