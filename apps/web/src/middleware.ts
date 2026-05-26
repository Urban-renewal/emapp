import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';

import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

/**
 * Auth-gate routes (closes §v9-H-2 + V10-S4 tier-aware extension).
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
  `^\\/[a-z]{2}\\/(login|signup|provider\\/login|accept-invite\\/${JWT_SHAPE})$`,
);
/**
 * Org-tier auth routes — bounce ANY user with `access_token` away.
 * Deliberately narrow: `/<locale>/login` and `/<locale>/signup` only.
 * Provider login is a SEPARATE auth route (`PROVIDER_AUTH_ROUTE_REGEX`)
 * because the bounce destination + the cookie check are tier-specific
 * (D.29 — different audiences mean different "logged in" semantics
 * per tier; lumping them together would risk bouncing an org user
 * away from /provider/login when they're trying to acquire a provider
 * session in addition to their org session, or vice-versa).
 */
const AUTH_ROUTE_REGEX = /^\/[a-z]{2}\/(login|signup)$/;
const PROVIDER_AUTH_ROUTE_REGEX = /^\/[a-z]{2}\/provider\/login$/;

/**
 * V10-S4 closure — Provider tier paths require `provider_access_token`,
 * NOT the org-tier `access_token`. Matches `/he/provider`, `/he/provider/`,
 * `/he/provider/tenants`, etc. The leading two-letter locale segment is
 * pinned (rejects `/provider/...` without a locale prefix, which can't
 * reach this surface anyway because the next-intl middleware would
 * 308-redirect; this regex catches the post-redirect state).
 *
 * Why a regex and not `pathname.startsWith('/${locale}/provider')`:
 *  - locale is dynamic (`he`/`en`); a generic regex avoids a per-locale
 *    helper.
 *  - the trailing boundary `(\/|$)` prevents `/he/providers` (plural,
 *    hypothetical) from being treated as the provider tier — exact
 *    segment match.
 */
const PROVIDER_TIER_REGEX = /^\/[a-z]{2}\/provider(\/|$)/;

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
function isProviderAuthRoute(pathname: string): boolean {
  return PROVIDER_AUTH_ROUTE_REGEX.test(pathname);
}
function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_REGEX.test(pathname) || PUBLIC_LOCALE_AGNOSTIC_REGEX.test(pathname);
}
function isLocaleAgnosticPublic(pathname: string): boolean {
  return PUBLIC_LOCALE_AGNOSTIC_REGEX.test(pathname);
}
function isProviderTierPath(pathname: string): boolean {
  return PROVIDER_TIER_REGEX.test(pathname);
}

/**
 * Locale prefix detector. Every authenticated FE path lives under
 * `/<locale>/...` (e.g. `/he/projects`); a raw `/projects` or
 * `/provider` arrives BEFORE next-intl has prefixed the locale.
 *
 * V10-S4 follow-up: WITHOUT this short-circuit, a `router.push('/provider')`
 * after a successful login would fall through to the auth-gate block,
 * see no org cookie, and redirect to `/he/login` — kicking the
 * just-authenticated Provider Admin straight back to the org login.
 * Locale-prefixed paths route through the tier-aware gates below;
 * non-prefixed paths defer to next-intl which will 308-redirect to
 * the locale-prefixed version, and THIS middleware re-enters with the
 * proper `/he/provider` to gate correctly.
 */
const LOCALE_PREFIX_REGEX = /^\/[a-z]{2}(\/|$)/;
function hasLocalePrefix(pathname: string): boolean {
  return LOCALE_PREFIX_REGEX.test(pathname);
}

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasOrgToken = req.cookies.has('access_token');
  const hasProviderToken = req.cookies.has('provider_access_token');

  // Locale-agnostic public routes (/sign/<jwt>): skip both gates and
  // next-intl so the URL stays short + the JWT-bearer flow is the only
  // auth mechanism.
  if (isLocaleAgnosticPublic(pathname)) {
    return NextResponse.next();
  }

  // V10-S4 follow-up — narrow defer for locale-less `/provider*` paths
  // when the user holds a provider cookie. Without this, the auth-gate
  // block below would see no org cookie and redirect the just-
  // authenticated Provider Admin to /he/login. Deferring to next-intl
  // lets it 308-prefix the locale → /he/provider → middleware
  // re-enters → tier-cookie gate passes them through.
  //
  // The check is intentionally narrow (only locale-less + /provider*
  // shape + provider cookie present). Other locale-less paths still
  // hit the existing auth-redirect block to preserve the single-
  // redirect behavior the M8/M13-M15 tests rely on (saves one
  // round-trip vs deferring everything to intl).
  if (!hasLocalePrefix(pathname) && /^\/provider(\/|$)/.test(pathname) && hasProviderToken) {
    return intlMiddleware(req);
  }

  // V10-S3 — Provider-tier auth page (`/<locale>/provider/login`):
  // bounce away ONLY if the user already has a provider session.
  // An org-tier user MAY visit this page to acquire a separate
  // provider session in addition to their org one (dual-role flow
  // — rare but legal); we don't bounce them.
  if (isProviderAuthRoute(pathname) && hasProviderToken) {
    const url = req.nextUrl.clone();
    const localeMatch = pathname.match(/^\/([a-z]{2})\//);
    const locale = localeMatch ? localeMatch[1] : 'he';
    url.pathname = `/${locale}/provider`;
    return NextResponse.redirect(url);
  }

  // Org-tier auth pages (/login, /signup): bounce away ANY user
  // with an org session. Provider-only sessions are NOT bounced
  // (they may be trying to acquire an org session, mirror of the
  // V10-S3 logic above). This narrower posture replaces the
  // earlier "any tier counts" rule which would have prevented a
  // Provider Admin from also logging into their org account.
  // v9-post-audit-SOLID-8 — preserve the locale prefix on redirect.
  if (isAuthRoute(pathname) && hasOrgToken) {
    const url = req.nextUrl.clone();
    const localeMatch = pathname.match(/^\/([a-z]{2})\//);
    const locale = localeMatch ? localeMatch[1] : 'he';
    url.pathname = `/${locale}`;
    return NextResponse.redirect(url);
  }

  // V10-S4 — Provider tier paths require the provider cookie.
  // Tier isolation: an org-only session navigating to /he/provider
  // gets redirected away (NOT silently rendered with the org session,
  // which would be a privilege confusion bug). Now that /provider/login
  // exists (V10-S2), unauthenticated visitors land there instead of
  // the org login.
  //
  // The `isProviderAuthRoute` short-circuit above means `/he/provider/login`
  // ITSELF is matched as a public route (PUBLIC_ROUTE_REGEX includes
  // it) and reaches this branch only as a fall-through, so we re-check
  // and explicitly let it pass — the page is the redirect target.
  if (isProviderTierPath(pathname) && !isProviderAuthRoute(pathname)) {
    if (!hasProviderToken) {
      const url = req.nextUrl.clone();
      const localeMatch = pathname.match(/^\/([a-z]{2})\//);
      const locale = localeMatch ? localeMatch[1] : 'he';
      url.pathname = `/${locale}/provider/login`;
      return NextResponse.redirect(url);
    }
    return intlMiddleware(req);
  }

  // Non-provider dashboard paths require the org cookie.
  // Anti-confusion: a Provider Admin with ONLY provider_access_token
  // navigating to /he/projects gets redirected to /login (their
  // provider token doesn't grant them org-tier access).
  if (!isPublicRoute(pathname) && !hasOrgToken && !pathname.startsWith('/api')) {
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
