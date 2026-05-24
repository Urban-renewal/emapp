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
 */
const PUBLIC_ROUTE_REGEX = /^\/[a-z]{2}\/(login|signup)$/;
const AUTH_ROUTE_REGEX = PUBLIC_ROUTE_REGEX; // same surface today; separate const
// keeps room for future "public but not an auth page" routes (e.g.
// `/sign/:token` in S10).

function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTE_REGEX.test(pathname);
}
function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_REGEX.test(pathname);
}

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasToken = req.cookies.has('access_token');

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

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
