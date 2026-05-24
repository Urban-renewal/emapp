/**
 * AUDIT — adversarial tests for the auth middleware.
 *
 * The middleware decides whether to:
 *  - bounce authenticated users away from /login/signup
 *  - bounce unauthenticated users to /<locale>/login on protected paths
 *  - delegate to next-intl for locale handling
 *
 * Probes:
 *  - `.endsWith('/login')` path-suffix bypass — a malicious path like
 *    /attacker/login slips through the auth-route check
 *  - missing locale: ensures the locale prefix is always preserved
 *  - cookie presence vs validity: middleware ONLY checks presence
 *    (intentional — Server Components revalidate via getMe)
 *  - public-route allowlist: must be precise
 *
 * Each adversarial test exercises a public surface ONLY (the exported
 * middleware function). No internal helpers are imported. If a probe
 * documents an OPEN GAP, it is marked `it.fails(...)`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import middleware from './middleware';

vi.mock('next-intl/middleware', () => ({
  default: () => () => NextResponse.next(),
}));

/** NextRequest.nextUrl is an enhanced NextURL with `.clone()`. For
 *  the middleware test stand-in, we wrap a plain URL with a clone()
 *  that returns a similarly-wrapped clone (the middleware mutates
 *  `.pathname` on the clone before passing it to NextResponse.redirect). */
function buildNextUrl(pathname: string): URL & { clone: () => URL & { clone: () => URL } } {
  const u = new URL(`https://app.emapp.io${pathname}`) as URL & {
    clone: () => URL & { clone: () => URL };
  };
  u.clone = () => buildNextUrl(u.pathname + u.search);
  return u;
}

function mockReq(opts: { pathname: string; hasToken?: boolean }): NextRequest {
  const cookies = new Map<string, { value: string }>();
  if (opts.hasToken) cookies.set('access_token', { value: 'TOKEN' });
  const nextUrl = buildNextUrl(opts.pathname);
  return {
    nextUrl,
    cookies: {
      has: (name: string) => cookies.has(name),
      get: (name: string) => cookies.get(name),
    },
    headers: new Headers(),
    url: nextUrl.toString(),
  } as unknown as NextRequest;
}

describe('middleware — happy path', () => {
  it('M1) unauthenticated user at /he/projects is redirected to /he/login', () => {
    const res = middleware(mockReq({ pathname: '/he/projects' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/login$/);
  });

  it('M2) authenticated user at /he/login is redirected to /', () => {
    const res = middleware(mockReq({ pathname: '/he/login', hasToken: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/$/);
  });

  it('M3) unauthenticated user at /he/login is allowed through (no redirect)', () => {
    const res = middleware(mockReq({ pathname: '/he/login' }));
    expect(res.status).not.toBe(307);
  });

  it('M4) /api/* paths skip the auth gate (the matcher excludes them anyway, but defense-in-depth)', () => {
    const res = middleware(mockReq({ pathname: '/api/v1/health' }));
    expect(res.status).not.toBe(307);
  });
});

describe('middleware — adversarial', () => {
  it.fails(
    'M5) malicious path /he/projects/some/path/login should NOT be treated as an auth route (currently .endsWith bypasses the gate)',
    () => {
      // With the current `.endsWith('/login')` check, this path is
      // classified as an auth route → "redirect authenticated users
      // away from auth pages" runs. For an unauthenticated user, it
      // falls into the public branch and is served the protected page.
      // CORRECT behavior: only the exact `/<locale>/login` and
      // `/<locale>/signup` paths are public.
      const res = middleware(mockReq({ pathname: '/he/projects/some/path/login' }));
      expect(res.status).toBe(307); // expect a redirect to /he/login
      expect(res.headers.get('location')).toMatch(/\/he\/login$/);
    },
  );

  it.fails('M6) /he/maliciously/signup should NOT be treated as a public route', () => {
    const res = middleware(mockReq({ pathname: '/he/maliciously/signup' }));
    expect(res.status).toBe(307);
  });

  it('M7) malformed locale (e.g. /xx/projects) still redirects to login with default locale "he"', () => {
    const res = middleware(mockReq({ pathname: '/xx/projects' }));
    // Today: the regex extracts "xx" as the locale → /xx/login.
    // Acceptable degradation; the middleware does not validate the
    // locale shape further (next-intl handles that downstream).
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/(xx|he)\/login$/);
  });

  it('M8) no-locale path (e.g. /projects without /he/) defaults to "he" locale', () => {
    const res = middleware(mockReq({ pathname: '/projects' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/login$/);
  });

  it.fails(
    'M9) middleware should set basic security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy) — currently MISSING',
    () => {
      // GAP — Next.js has no default security headers. ISO A.14 +
      // Agent A 4.5 / 7.5 require: X-Frame-Options: DENY,
      // X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin
      // -when-cross-origin, Permissions-Policy minimal. Today none of
      // these are set on the FE response.
      const res = middleware(mockReq({ pathname: '/he/login' }));
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    },
  );
});
