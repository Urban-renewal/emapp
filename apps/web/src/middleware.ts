import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';

import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

const AUTH_ROUTES = ['/login', '/signup'];
const PUBLIC_ROUTES = ['/login', '/signup'];

function isAuthRoute(pathname: string) {
  return AUTH_ROUTES.some((r) => pathname.endsWith(r));
}

function isPublicRoute(pathname: string) {
  return PUBLIC_ROUTES.some((r) => pathname.endsWith(r));
}

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasToken = req.cookies.has('access_token');

  // Redirect authenticated users away from auth pages
  if (isAuthRoute(pathname) && hasToken) {
    const url = req.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  // Redirect unauthenticated users to login for non-public routes
  if (!isPublicRoute(pathname) && !hasToken && !pathname.startsWith('/api')) {
    const url = req.nextUrl.clone();
    // Determine locale prefix (e.g. /he/ or /en/)
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
