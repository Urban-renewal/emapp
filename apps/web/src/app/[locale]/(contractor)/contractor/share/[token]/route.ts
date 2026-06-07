import { type NextRequest, NextResponse } from 'next/server';

import { routing } from '@/i18n/routing';

/**
 * Phase 3 #5 — contractor share-token → httpOnly cookie EXCHANGE.
 *
 * THE PROBLEM this closes: the 30-day share-access token used to ride in the
 * URL PATH (`/contractor/share/<jwt>`) and was the sole credential, re-read
 * from the URL on every API call as a `Bearer` header. A token in the URL
 * leaks three ways: browser history, the `Referer` header to any third-party
 * asset, and server/proxy access logs.
 *
 * THE FIX: this Route Handler is the landing target for the share link. On
 * first load it
 *   1. structurally validates the JWT shape (defense-in-depth; the BE
 *      ContractorAuthGuard remains the SOLE authority — it re-verifies the
 *      signature, audience `emapp-share`, and the live `shares` row on EVERY
 *      request),
 *   2. sets an **httpOnly, Secure, SameSite=Lax** cookie
 *      `contractor_access_token` whose Max-Age matches the token's REMAINING
 *      TTL (read from the JWT's own `exp` claim — we never extend the TTL),
 *   3. **303-redirects to a CLEAN URL** (`/<locale>/contractor/share`) with no
 *      token in it.
 *
 * After the redirect the token lives only in an httpOnly cookie: it is gone
 * from the address bar, never enters browser history for the clean view, is
 * not in the `Referer` of any asset the clean page loads, and is NOT readable
 * by JavaScript (httpOnly). Subsequent `/api/v1/contractor/*` calls
 * authenticate via the cookie, which the same-origin proxy forwards verbatim
 * and the guard reads from `req.cookies['contractor_access_token']`.
 *
 * Why a Route Handler (not a Server Component): Next.js only permits writing
 * cookies from a Route Handler or Server Action — never during a page render.
 * This handler replaces the old `[token]/page.tsx`; the clean view now lives
 * at the sibling `../page.tsx`.
 *
 * We do NOT call the BE here: the exchange is a pure cookie-set + redirect.
 * An invalid / expired / revoked token is detected on the FIRST data fetch
 * from the clean page, which renders the generic "invalid link" error (no
 * oracle on WHY — same posture as the BE's generic 401). This keeps a single
 * source of truth for token verification (the guard) and avoids a second
 * round-trip on the happy path.
 */

const COOKIE_NAME = 'contractor_access_token';
// Mirror auth.service.ts COOKIE_BASE: Secure everywhere except local dev/test.
const SECURE = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';
// Hard ceiling — the token's own TTL is 30 days (SHARE_TOKEN_TTL_SECONDS). We
// never set a cookie that outlives the token; if `exp` is missing/garbled we
// fall back to this and let the guard reject an over-aged token anyway.
const MAX_COOKIE_AGE_SEC = 30 * 24 * 60 * 60;

/** A share token is a JWT: three base64url segments joined by '.'. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const LOCALES = new Set<string>(routing.locales);
function safeLocale(raw: string | undefined): string {
  return raw && LOCALES.has(raw) ? raw : routing.defaultLocale;
}

/**
 * Remaining cookie lifetime in seconds, derived from the JWT's `exp` claim.
 * This NEVER extends the token: it reads (does not trust) the unverified
 * payload purely to bound the cookie's Max-Age to what's left of the token's
 * locked TTL. Clamped to (0, MAX_COOKIE_AGE_SEC]. Returns null if the token is
 * already expired or `exp` is unreadable (→ caller treats the link as dead).
 */
function remainingTtlSeconds(token: string): number | null {
  const [, payloadSegment] = token.split('.');
  if (!payloadSegment) return null;
  try {
    // base64url → JSON. No signature trust here — bounding only.
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp !== 'number') return null;
    const remaining = Math.floor(payload.exp - Date.now() / 1000);
    if (remaining <= 0) return null;
    return Math.min(remaining, MAX_COOKIE_AGE_SEC);
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ locale: string; token: string }> },
): Promise<Response> {
  const { locale: rawLocale, token } = await ctx.params;
  const locale = safeLocale(rawLocale);

  const cleanUrl = req.nextUrl.clone();
  cleanUrl.pathname = `/${locale}/contractor/share`;
  cleanUrl.search = '';

  // Malformed or already-expired token: never set a cookie; send the visitor
  // straight to the clean view, which renders the generic invalid-link error
  // (the guard would 401 the cookie anyway — no oracle either way).
  const ttl = JWT_SHAPE.test(token) ? remainingTtlSeconds(token) : null;
  if (ttl === null) {
    return NextResponse.redirect(cleanUrl, { status: 303 });
  }

  // 303 See Other — the share link is a GET navigation; 303 makes the browser
  // re-issue the redirect target as a GET to the token-less URL.
  const res = NextResponse.redirect(cleanUrl, { status: 303 });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'lax',
    // path '/' is required: the cookie must ride BOTH the clean page
    // (`/<locale>/contractor/share`) AND the API proxy (`/api/v1/contractor/*`).
    // Mirrors the org `access_token` (auth.service.ts path '/').
    path: '/',
    maxAge: ttl,
  });
  return res;
}
