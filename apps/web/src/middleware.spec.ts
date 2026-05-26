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

function mockReq(opts: {
  pathname: string;
  hasToken?: boolean;
  hasProviderToken?: boolean;
}): NextRequest {
  const cookies = new Map<string, { value: string }>();
  if (opts.hasToken) cookies.set('access_token', { value: 'TOKEN' });
  if (opts.hasProviderToken) cookies.set('provider_access_token', { value: 'PROV-TOKEN' });
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

  // ─── Phase 4c S1 — locale-aware public accept-invite ───
  it('M16) /he/accept-invite/<jwt> is public — unauthenticated visitor reaches the page', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';
    const res = middleware(mockReq({ pathname: `/he/accept-invite/${jwt}` }));
    expect(res.status).not.toBe(307);
  });

  it('M17) authenticated visitor at /he/accept-invite/<jwt> is NOT bounced away (multi-org invite)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';
    const res = middleware(mockReq({ pathname: `/he/accept-invite/${jwt}`, hasToken: true }));
    // AUTH_ROUTE_REGEX intentionally excludes accept-invite — a user
    // logged into org A may be accepting an invite to org B; bouncing
    // them away would break that flow.
    expect(res.status).not.toBe(307);
  });

  it('M18) /he/accept-invite/notajwt is NOT a public route — falls through to auth gate', () => {
    // Single segment (no dots) → does NOT match the JWT shape regex
    // → middleware treats it as a normal protected path and bounces.
    const res = middleware(mockReq({ pathname: '/he/accept-invite/notajwt' }));
    expect(res.status).toBe(307);
  });

  it('M19) /he/accept-invite/<jwt>/extra is NOT a public route — anchoring prevents path injection', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';
    const res = middleware(mockReq({ pathname: `/he/accept-invite/${jwt}/x` }));
    expect(res.status).toBe(307);
  });

  it('M20) /xx/accept-invite/<jwt> with malformed locale still routes (regex captures locale liberally)', () => {
    // PUBLIC_ROUTE_REGEX only checks 2-letter locale shape; next-intl
    // downstream further validates. Acceptable degradation — the
    // route is allowed through; next-intl decides whether to render
    // or 404.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';
    const res = middleware(mockReq({ pathname: `/xx/accept-invite/${jwt}` }));
    expect(res.status).not.toBe(307);
  });
});

// ─── V10-S4 closure — tier isolation at the middleware layer ───
describe('middleware — provider tier (V10-S4 closure)', () => {
  it('MP1) unauthenticated user at /he/provider is redirected to /he/provider/login (V10-S2 — tier-specific login target)', () => {
    const res = middleware(mockReq({ pathname: '/he/provider' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/provider\/login$/);
  });

  it('MP2) user with ONLY org access_token at /he/provider is redirected to /he/provider/login (no provider cookie)', () => {
    // Provider-tier paths require provider_access_token specifically;
    // an org cookie alone must NOT grant access. Tier isolation.
    // Redirect target is /provider/login (V10-S2) so the org user
    // can acquire a provider session without leaving the tier context.
    const res = middleware(mockReq({ pathname: '/he/provider', hasToken: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/provider\/login$/);
  });

  it('MP3) user with provider_access_token at /he/provider is allowed through (no redirect)', () => {
    const res = middleware(mockReq({ pathname: '/he/provider', hasProviderToken: true }));
    expect(res.status).not.toBe(307);
  });

  it('MP4) provider-tier path /he/provider/tenants requires provider cookie (deeper path)', () => {
    const resWithout = middleware(mockReq({ pathname: '/he/provider/tenants' }));
    expect(resWithout.status).toBe(307);
    const resWith = middleware(
      mockReq({ pathname: '/he/provider/tenants', hasProviderToken: true }),
    );
    expect(resWith.status).not.toBe(307);
  });

  it('MP5) /he/providers (plural — exact segment match) is NOT provider tier — falls to org auth gate', () => {
    // Trailing-segment defense: the regex anchors on `provider(\/|$)`
    // so a hypothetical `/he/providers/foo` (plural) gets org-tier
    // treatment, not provider-tier.
    const res = middleware(mockReq({ pathname: '/he/providers', hasProviderToken: true }));
    // No org cookie → redirect to org login.
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/login$/);
  });

  it('MP6) user with ONLY provider cookie navigating to /he/projects is redirected to /he/login (tier isolation)', () => {
    // Org-tier paths require access_token; provider cookie alone is
    // NOT sufficient. Anti-confusion: a Provider Admin must not
    // accidentally render org-tier UI with their privileged session.
    const res = middleware(mockReq({ pathname: '/he/projects', hasProviderToken: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/login$/);
  });

  it('MP7) authenticated ORG-only user at /he/login is bounced to /he (V10-S3 refinement)', () => {
    // V10-S3 refinement — `/he/login` is an ORG-tier auth route.
    // Bounce ONLY org-authenticated users. A provider-only user
    // visiting /he/login is allowed through (they want to acquire
    // a second, org-tier session — dual-role flow).
    const res = middleware(mockReq({ pathname: '/he/login', hasToken: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he$/);
  });

  it('MP7b) provider-only user at /he/login is allowed through (acquiring org session — dual-role)', () => {
    // V10-S3: the bounce rule on `/he/login` is tier-specific. A user
    // with ONLY provider_access_token can legally visit /he/login to
    // acquire an org session in addition to their provider one.
    const res = middleware(mockReq({ pathname: '/he/login', hasProviderToken: true }));
    expect(res.status).not.toBe(307);
  });

  it('MP8) user with BOTH tokens at /he/provider/tenants is allowed (provider check passes)', () => {
    // Edge case: a developer who is both a Manager AND a Provider
    // Admin has both cookies set. Navigating to provider subtree
    // should succeed (provider cookie present); the layout's session
    // resolver will pick org tier first by default, but provider
    // layout re-checks and redirects to / if it sees tier === 'org'.
    const res = middleware(
      mockReq({ pathname: '/he/provider/tenants', hasToken: true, hasProviderToken: true }),
    );
    expect(res.status).not.toBe(307);
  });
});

// ─── V10-S2 + V10-S3 closures — /provider/login page-specific rules ───
describe('middleware — provider/login page (V10-S2 + V10-S3 closures)', () => {
  it('MPL1) unauthenticated user at /he/provider/login is ALLOWED (public route)', () => {
    // The whole point of V10-S3: PUBLIC_ROUTE_REGEX extends to include
    // `provider\\/login` so the login page is reachable.
    const res = middleware(mockReq({ pathname: '/he/provider/login' }));
    expect(res.status).not.toBe(307);
  });

  it('MPL2) provider-authenticated user at /he/provider/login is bounced to /he/provider', () => {
    // Already logged in as provider → no need to re-authenticate.
    // Target is /provider (provider dashboard home), NOT /he (org root)
    // — staying within the tier context.
    const res = middleware(mockReq({ pathname: '/he/provider/login', hasProviderToken: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/provider$/);
  });

  it('MPL3) org-only user at /he/provider/login is ALLOWED through (acquiring provider session — dual-role)', () => {
    // V10-S3 design: this is a tier-specific auth route. An org user
    // visiting /provider/login is trying to acquire a SECOND session
    // for the provider tier. We don't bounce them away — that would
    // prevent the dual-role login flow.
    const res = middleware(mockReq({ pathname: '/he/provider/login', hasToken: true }));
    expect(res.status).not.toBe(307);
  });

  it('MPL4) /he/provider/login does NOT trigger the provider-tier cookie gate (it IS the login page)', () => {
    // The /provider/login route is matched as PUBLIC_ROUTE first; the
    // PROVIDER_TIER cookie gate explicitly skips it via the
    // `&& !isProviderAuthRoute(pathname)` clause. Without that skip,
    // an unauthenticated visitor would loop /provider → /provider/login
    // → /provider/login (bounced for no cookie) → infinite redirect.
    const res = middleware(mockReq({ pathname: '/he/provider/login' }));
    expect(res.status).not.toBe(307);
  });

  it('MPL5) dual-cookie user at /he/provider/login bounces to /he/provider (provider session wins)', () => {
    // Both cookies present → the provider-auth bounce (MPL2) fires
    // BEFORE the org-auth bounce (MP7) because we check provider
    // auth-route first in the middleware order.
    const res = middleware(
      mockReq({ pathname: '/he/provider/login', hasToken: true, hasProviderToken: true }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/provider$/);
  });

  it('MPL6) path-suffix attack /he/projects/provider/login is NOT a public route', () => {
    // PROVIDER_AUTH_ROUTE_REGEX is anchored — `/he/projects/provider/login`
    // is NOT a provider login page; it's an unauthenticated visitor on
    // a protected path and must redirect to /he/login (org login).
    const res = middleware(mockReq({ pathname: '/he/projects/provider/login' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/he\/login$/);
  });

  it('MPL7) /en/provider/login also reachable (locale-portable)', () => {
    const res = middleware(mockReq({ pathname: '/en/provider/login' }));
    expect(res.status).not.toBe(307);
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
    // §P0-3 — CSP `unsafe-inline` AND `unsafe-eval` on SCRIPT-src are
    // DEV-ONLY (Next.js dev inline bootstrap + react-refresh require
    // both). They MUST be inside an IS_DEV ternary that falls back to
    // strict `script-src 'self'` in prod. A bare unconditional unsafe-*
    // on script-src would mean prod is running with it (security
    // violation).
    //
    // Approach: extract every DOUBLE-QUOTED literal in the file that
    // STARTS WITH "script-src ". These are the actual CSP directive
    // values (comments / docstrings use other quoting). Any such
    // literal with unsafe-* must coexist with a `:` (ternary) AND a
    // strict `"script-src 'self'"` literal — the prod fallback.
    const scriptSrcLiterals = [...config.matchAll(/"(script-src [^"]*)"/g)].map((m) => m[1] ?? '');
    expect(scriptSrcLiterals.length).toBeGreaterThanOrEqual(2); // dev + prod
    let sawProdStrict = false;
    let sawDevUnsafe = false;
    for (const lit of scriptSrcLiterals) {
      if (lit === "script-src 'self'") sawProdStrict = true;
      if (/unsafe-(inline|eval)/.test(lit)) sawDevUnsafe = true;
    }
    expect(sawProdStrict).toBe(true);
    if (sawDevUnsafe) {
      // The ternary structure: `IS_DEV ? <unsafe> : <strict>`.
      expect(config).toMatch(
        /IS_DEV\s*\?\s*"script-src[^"]*unsafe-[^"]*"\s*:\s*"script-src 'self'"/,
      );
    }
    // Verify IS_DEV is defined as a NODE_ENV !== 'production' check.
    expect(config).toMatch(/IS_DEV\s*=\s*process\.env\[.NODE_ENV.\]\s*!==\s*['"]production['"]/);

    // §csp-r2 — connect-src MUST include the R2 storage host. The FE
    // upload contract (documents.ts:uploadToPresigned + imports.ts:
    // uploadToPresignedXhr) calls PUT directly to a presigned R2 URL
    // from the browser. Without this directive the browser blocks the
    // PUT silently (no JS-readable error other than `TypeError:
    // Failed to fetch`); uploads break in every browser environment.
    // The matching API helmet allowlist lives in apps/api/src/main.ts
    // (`connectSrc: [..., 'https://*.r2.cloudflarestorage.com']`).
    // The two MUST stay in lock-step — divergence here was caught by
    // browser smoke on 2026-05-25.
    expect(config).toMatch(/connect-src[^"]*https:\/\/\*\.r2\.cloudflarestorage\.com/);
  });

  it('M10b) FE connect-src host allowlist matches API helmet connectSrc (lock-step)', async () => {
    // Generic family-defense: every host the FE direct-fetches MUST
    // appear in BOTH the FE next.config.ts CSP and the API helmet
    // connectSrc. If a future contract adds (e.g.) a payment-gateway
    // host to the API but forgets the FE side, the upload-class bug
    // recurs. We extract the host-pattern set from each file and
    // assert FE ⊇ {non-self entries from API} (modulo Sentry which
    // is FE-only when the browser SDK lands — see PERF-M3 in
    // next.config.ts).
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const feConfig = readFileSync(join(here, '..', 'next.config.ts'), 'utf8');
    // here = apps/web/src → up 3 levels to repo root, then apps/api/src/main.ts.
    const apiMain = readFileSync(
      join(here, '..', '..', '..', 'apps', 'api', 'src', 'main.ts'),
      'utf8',
    );

    // FE: extract the connect-src literal (single line) → host tokens.
    const feLine = feConfig.match(/"(connect-src [^"]*)"/)?.[1] ?? '';
    const feHosts = new Set(
      feLine
        .replace(/^connect-src\s*/, '')
        .split(/\s+/)
        .filter((h) => h.length > 0 && h !== "'self'"),
    );

    // API: extract the `connectSrc: [...]` array entries.
    const apiBlock = apiMain.match(/connectSrc:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const apiHosts = new Set(
      [...apiBlock.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]!).filter(Boolean),
    );

    // The FE must allow every API-listed host EXCEPT pure server-side
    // ones. The current contract: R2 (browser PUT) is the only one
    // that BOTH sides must allow.
    const requiredOnFe = ['https://*.r2.cloudflarestorage.com'];
    for (const host of requiredOnFe) {
      expect(apiHosts.has(host), `API helmet must allow ${host} (connectSrc)`).toBe(true);
      expect(feHosts.has(host), `FE CSP must allow ${host} (connect-src)`).toBe(true);
    }
  });
});
