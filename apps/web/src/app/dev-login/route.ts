/**
 * DEV-ONLY navigation login — for browser-driven QA tooling only.
 *
 * ============================ WHY THIS EXISTS ============================
 * The app's normal login is `fetch`-based: the browser POSTs
 * `/api/v1/auth/login`, the API replies with `Set-Cookie` on the FETCH
 * response, and the browser stores the httpOnly session cookies. A
 * CDP-driven browser (Claude-in-Chrome MCP) does NOT reliably persist a
 * cookie that arrives on a `fetch()` response — but it DOES persist
 * cookies that arrive on a NAVIGATION / redirect response.
 *
 * This route bridges that gap: a GET navigation to `/dev-login?role=...`
 * performs the login server-side and then 302-redirects to `/he` with the
 * upstream `Set-Cookie` headers forwarded VERBATIM onto the redirect — so
 * the browser stores them on the navigation and follows to the
 * authenticated dashboard with a real session.
 *
 * ========================== WHY THIS IS SAFE ============================
 * This is an AUTH-ADJACENT, DEV-ONLY surface. It is DOUBLE-GATED and
 * FAILS CLOSED — it is provably impossible to mint a session in
 * production:
 *
 *   1. `NODE_ENV === 'development'` AND
 *   2. an explicit opt-in `DEV_AUTH_BYPASS === '1'`
 *
 * These are the EXACT two conditions of the API-side auth bypass
 * (`apps/api/src/common/dev-auth-bypass.gate.ts` → `computeDevAuthBypass`).
 * If EITHER is false the handler returns `notFound()` (HTTP 404 — NOT 403,
 * so there is no existence disclosure of a dev-only endpoint in prod). The
 * explicit `DEV_AUTH_BYPASS` flag is the real guard (NODE_ENV can default
 * to 'development' in some toolchains); prod never sets it.
 *
 * The seed password is a server-side constant in THIS file. It is NEVER in
 * the URL/query string, NEVER logged, and never sent to the browser. The
 * `role` query param is validated against a fixed allowlist; anything else
 * → 404. The redirect target is a FIXED constant (`/he` on success,
 * `/he/login` on failure) — never user-controlled, so there is no
 * open-redirect. We FORWARD the upstream `Set-Cookie` (never forge a
 * cookie value ourselves).
 *
 * Mirrors the API double-gate pattern intentionally so the two surfaces
 * stay in lock-step. See `apps/api/src/common/dev-auth-bypass.ts`.
 */
import { notFound } from 'next/navigation';
import { type NextRequest, NextResponse } from 'next/server';

import { getBackendBase } from '../api/[...path]/route';

// Force the Node runtime (we read upstream `Set-Cookie` via getSetCookie()).
export const runtime = 'nodejs';
// Never cache a login redirect.
export const dynamic = 'force-dynamic';

/**
 * PURE double-gate — mirror of `computeDevAuthBypass` in
 * `apps/api/src/common/dev-auth-bypass.gate.ts`. Kept inline (not imported
 * from `@emapp/config`) so the web bundle does not pull in the API's
 * serverEnv (which would require DATABASE_URL etc. just to evaluate a
 * boolean). Same semantics, same prod-impossibility.
 */
export function computeDevNavLoginEnabled(
  nodeEnv: string | undefined,
  flag: string | undefined,
): boolean {
  return nodeEnv === 'development' && flag === '1';
}

/** The dev-seed login password. Server-side constant — never in a URL,
 *  never logged. Matches the seeded dev users (see e2e/audit/_helpers.ts). */
const DEV_SEED_PASSWORD = 'DevPassword123!';

/**
 * Role → dev-seed email allowlist. The KEYS are the only accepted `?role=`
 * values; an unknown role is treated as not-found (404). The emails are the
 * well-known seeded dev accounts; the password is the shared constant above.
 */
const ROLE_TO_EMAIL = {
  manager: 'manager@alpha.dev',
  agent: 'agent@alpha.dev',
  viewer: 'viewer@alpha.dev',
  managerBeta: 'manager@beta.dev',
} as const;

type DevRole = keyof typeof ROLE_TO_EMAIL;

function isDevRole(value: string): value is DevRole {
  return Object.prototype.hasOwnProperty.call(ROLE_TO_EMAIL, value);
}

/** Fixed, NON-user-controlled redirect targets (no open-redirect surface). */
const SUCCESS_REDIRECT = '/he';
const FAILURE_REDIRECT = '/he/login';

export async function GET(req: NextRequest): Promise<Response> {
  // ---- Gate 1+2: double-gated, fail-closed. 404 (not 403) in prod. ----
  if (!computeDevNavLoginEnabled(process.env['NODE_ENV'], process.env['DEV_AUTH_BYPASS'])) {
    notFound();
  }

  // ---- Role allowlist (default manager). Unknown role → 404. ----
  const roleParam = req.nextUrl.searchParams.get('role') ?? 'manager';
  if (!isDevRole(roleParam)) {
    notFound();
  }
  const email = ROLE_TO_EMAIL[roleParam];

  // ---- Server-side login against the same backend the proxy targets. ----
  const base = getBackendBase();
  const target = new URL(req.nextUrl.origin);

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The password is in the BODY, never the URL. Not logged.
      body: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Backend unreachable — bounce to login WITHOUT a cookie. Never 500-leak.
    target.pathname = FAILURE_REDIRECT;
    target.search = '';
    return NextResponse.redirect(target, 302);
  }

  if (!upstream.ok) {
    // API rejected the dev creds (non-200) — bounce to login, no cookie.
    target.pathname = FAILURE_REDIRECT;
    target.search = '';
    return NextResponse.redirect(target, 302);
  }

  // ---- Success: 302 → /he, FORWARDING the upstream Set-Cookie verbatim. ----
  target.pathname = SUCCESS_REDIRECT;
  target.search = '';
  const res = NextResponse.redirect(target, 302);

  // Handle MULTIPLE Set-Cookie headers correctly. `Headers.getSetCookie()`
  // (Node 18.14+/undici) returns each cookie as a distinct array entry;
  // `headers.get('set-cookie')` would fold them into one comma-joined
  // string and corrupt the values. We append each verbatim — we FORWARD
  // the API's cookies (access_token + refresh_token), never forge them.
  const setCookies = upstream.headers.getSetCookie();
  for (const cookie of setCookies) {
    res.headers.append('set-cookie', cookie);
  }

  return res;
}
