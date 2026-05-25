import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';

import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

/**
 * Auth-gate routes (closes §v9-H-2).
 *
 * Strict regex match — `.endsWith('/login')` was a path-suffix bypass
 * (a path like `/he/projects/legacy/login` slipped through). We now
 * pin the exact public surface: `/<locale>/login` and
 * `/<locale>/signup` only, where `<locale>` is two lowercase letters
 * (the next-intl locale shape).
 *
 * Phase 4c S1 — extend with `/<locale>/accept-invite/<jwt>` (D.27
 * member-invite landing). The JWT shape (3 base64url segments joined
 * by `.`) is pinned so a path like `/he/accept-invite/whatever` cannot
 * masquerade as the public surface. AUTH_ROUTE_REGEX stays narrow
 * (login|signup only) so authenticated users are NOT bounced away
 * from /accept-invite — they may be accepting an invite to a
 * different org with their existing session intact.
 */
const JWT_SHAPE = '[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+';
const PUBLIC_ROUTE_REGEX = new RegExp(
  `^\\/[a-z]{2}\\/(login|signup|accept-invite\\/${JWT_SHAPE})$`,
);
const AUTH_ROUTE_REGEX = /^\/[a-z]{2}\/(login|signup)$/;

/**
 * Routes that bypass BOTH the auth gate AND next-intl locale routing.
 * S10 — `/sign/<token>` is the public residents' signing surface:
 *  - It's locale-agnostic (the JWT carries everything we need; URL has
 *    no locale prefix so SMS/WhatsApp links stay short + opaque).
 *  - It's auth-bearer (JWT in the path); no cookie required.
 *  - We deliberately do NOT 302-redirect to /login if there's no cookie
 *    — the resident is anonymous by design.
 * The token shape is JWT (header.payload.signature, base64url segments
 * separated by `.`). Pinning the shape with a regex prevents a stray
 * `/sign/foo` from bypassing the auth gate for arbitrary paths.
 */
const PUBLIC_LOCALE_AGNOSTIC_REGEX = /^\/sign\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTE_REGEX.test(pathname);
}
function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_REGEX.test(pathname) || PUBLIC_LOCALE_AGNOSTIC_REGEX.test(pathname);
}
function isLocaleAgnosticPublic(pathname: string): boolean {
  return PUBLIC_LOCALE_AGNOSTIC_REGEX.test(pathname);
}

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasToken = req.cookies.has('access_token');

  // Locale-agnostic public routes (/sign/<jwt>): skip both gates and
  // next-intl so the URL stays short + the JWT-bearer flow is the only
  // auth mechanism.
  if (isLocaleAgnosticPublic(pathname)) {
    return NextResponse.next();
  }

  // Redirect authenticated users away from auth pages.
  // v9-post-audit-SOLID-8 — preserve the locale prefix on the redirect
  // target so the user lands on `/he/` not `/` (which would 404 then
  // bounce via next-intl, adding a round-trip).
  if (isAuthRoute(pathname) && hasToken) {
    const url = req.nextUrl.clone();
    const localeMatch = pathname.match(/^\/([a-z]{2})\//);
    const locale = localeMatch ? localeMatch[1] : 'he';
    url.pathname = `/${locale}`;
    return NextResponse.redirect(url);
  }

  // Redirect unauthenticated users to login for non-public routes.
  if (!isPublicRoute(pathname) && !hasToken && !pathname.startsWith('/api')) {
    const url = req.nextUrl.clone();
    const localeMatch = pathname.match(/^\/([a-z]{2})\//);
    const locale = localeMatch ? localeMatch[1] : 'he';
    url.pathname = `/${locale}/login`;
    return NextResponse.redirect(url);
  }

  return intlMiddleware(req);
}

/**
 * Matcher invariant — defense in depth.
 *
 * The default Next.js matcher excludes any path containing a `.` so
 * that static assets (`/favicon.ico`, `/_next/static/foo.js`, etc.)
 * don't pay the middleware cost. But JWT path segments (`/sign/<jwt>`)
 * DO contain dots — without an explicit allow-list we would skip the
 * middleware for the public-sign surface entirely, leaving it
 * un-gated. We add a second matcher entry that explicitly matches
 * `/sign/*` so isLocaleAgnosticPublic / fall-through logic runs there
 * too. The BE's atomic single-use guard is the source of truth, but
 * the middleware still gets to enforce the JWT-shape regex client-side
 * (anti-enumeration: malformed token → /he/login redirect, not a
 * page-render attempt).
 */
export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)', '/sign/:path*'],
};
