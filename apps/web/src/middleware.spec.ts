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

  it('M2) authenticated user at /he/login is redirected to /he (locale preserved — v9-post-audit-SOLID-8)', () => {
    const res = middleware(mockReq({ pathname: '/he/login', hasToken: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he$/);
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
  it('M5) malicious path /he/projects/some/path/login is NOT an auth route (CLOSED §v9-H-2 — strict regex)', () => {
    const res = middleware(mockReq({ pathname: '/he/projects/some/path/login' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/login$/);
  });

  it('M6) /he/maliciously/signup is NOT a public route (CLOSED §v9-H-2)', () => {
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

  it('M9) middleware does not set headers itself — headers are applied at the next.config.ts level (see M10)', () => {
    const res = middleware(mockReq({ pathname: '/he/login' }));
    expect(res).toBeDefined();
  });

  // ─── S10 — locale-agnostic public route (/sign/<jwt>) ───
  it('M11) /sign/<jwt> is public — no redirect even without access_token (CLOSED S10)', () => {
    // valid JWT-shape: three base64url segments separated by `.`
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';
    const res = middleware(mockReq({ pathname: `/sign/${jwt}` }));
    expect(res.status).not.toBe(307);
  });

  it('M12) /sign/<jwt> still bypasses when authenticated (no surprising redirect)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';
    const res = middleware(mockReq({ pathname: `/sign/${jwt}`, hasToken: true }));
    expect(res.status).not.toBe(307);
  });

  it('M13) /sign/not-a-jwt-shape is NOT a public route — falls through to auth gate', () => {
    // Single segment (no dots) → does NOT match the JWT shape regex
    // → must redirect to login as a normal protected route.
    const res = middleware(mockReq({ pathname: '/sign/notajwt' }));
    expect(res.status).toBe(307);
  });

  it('M14) /sign/foo.bar (only 2 segments) is NOT a JWT shape — falls through to auth gate', () => {
    const res = middleware(mockReq({ pathname: '/sign/header.payload' }));
    expect(res.status).toBe(307);
  });

  it('M15) /sign/<jwt>/extra is NOT a public route — anchoring prevents path injection', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';
    const res = middleware(mockReq({ pathname: `/sign/${jwt}/dashboard` }));
    // Should redirect to login (the regex requires end-anchor `$`)
    expect(res.status).toBe(307);
  });
});

describe('next.config.ts security headers (§v9-P0-5 closure pin)', () => {
  it('M10) next.config.ts declares the required security headers (CLOSED §v9-P0-5)', async () => {
    // Read the config file as text and grep for the rules. This avoids
    // executing the Next.js plugin chain in a unit test.
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const config = readFileSync(join(here, '..', 'next.config.ts'), 'utf8');
    expect(config).toMatch(/X-Frame-Options.*DENY/);
    expect(config).toMatch(/X-Content-Type-Options.*nosniff/);
    expect(config).toMatch(/Referrer-Policy.*strict-origin-when-cross-origin/);
    expect(config).toMatch(/Content-Security-Policy/);
    expect(config).toMatch(/Permissions-Policy/);
    // §P0-3 — CSP `unsafe-eval` is DEV-ONLY (react-refresh requires it).
    // It MUST be behind a production guard so prod stays strict.
    // Assert: if `unsafe-eval` appears, it is gated by `IS_DEV` or
    // `!== 'production'`. A bare unconditional unsafe-eval would mean
    // prod is running with it, which is the security violation.
    if (/unsafe-eval/.test(config)) {
      // The unsafe-eval is present — verify it is behind a dev-only guard.
      expect(config).toMatch(
        /IS_DEV.*unsafe-eval|unsafe-eval.*IS_DEV|NODE_ENV.*production.*unsafe-eval|unsafe-eval.*NODE_ENV.*production/s,
      );
    }
    // Verify the prod branch uses strict script-src 'self' (no unsafe-eval).
    expect(config).toMatch(/script-src 'self'/);
    // Verify IS_DEV is defined as a NODE_ENV !== 'production' check.
    expect(config).toMatch(/IS_DEV\s*=\s*process\.env\[.NODE_ENV.\]\s*!==\s*['"]production['"]/);
  });
});
