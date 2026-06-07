/**
 * ADVERSARIAL tests — Phase 3 #5 contractor share-token → httpOnly cookie
 * EXCHANGE Route Handler (`[token]/route.ts`).
 *
 * Written by the TEST-AUTHOR (not the builder). The threat model: the
 * 30-day share-access token USED to ride in the URL path and was the sole
 * credential. The whole point of this slice is to move it into an
 * httpOnly+Secure+SameSite=Lax cookie and strip it from the address bar.
 *
 * The load-bearing assertions here are the cookie ATTRIBUTES (a missing
 * httpOnly, Secure, or SameSite is the entire vulnerability) and the
 * Max-Age DERIVATION (the cookie must never outlive the token's own `exp`
 * — extending the TTL would resurrect a server-revoked-by-expiry link).
 *
 * We assert on the RAW `Set-Cookie` header string (concrete attribute
 * tokens) AND the structured `res.cookies.get()` object — belt and braces,
 * because a builder could set an attribute on one path and not the other.
 *
 * `safeLocale` is mocked-free: routing locales are `he`/`en` (see
 * i18n/routing.ts), so a bad locale falls back to `he` (the default).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const COOKIE_NAME = 'contractor_access_token';
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;

/** Build a structurally-valid JWT (3 base64url segments) whose payload
 *  carries the given `exp` (epoch seconds). The signature segment is
 *  arbitrary — this handler NEVER verifies the signature (the BE guard
 *  is the sole authority); it only shape-checks + reads `exp` to bound
 *  the cookie Max-Age. */
function jwtWithExp(expSeconds: number | undefined): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify(expSeconds === undefined ? { sub: 'share' } : { sub: 'share', exp: expSeconds }),
  );
  // signature segment: opaque base64url, never inspected.
  const sig = 'c2lnbmF0dXJlLXBsYWNlaG9sZGVy';
  return `${header}.${payload}.${sig}`;
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Minimal NextRequest stand-in. The handler reads ONLY
 *  `req.nextUrl.clone()` (then mutates pathname/search on the clone).
 *  We give clone() a real URL so pathname/search assignment + .toString()
 *  behave exactly as in prod. */
function mockReq(pathname = '/he/contractor/share/whatever'): import('next/server').NextRequest {
  const make = () => new URL(`https://app.emapp.io${pathname}`);
  return {
    nextUrl: {
      clone: () => make(),
    },
  } as unknown as import('next/server').NextRequest;
}

function ctx(token: string, locale = 'he') {
  return { params: Promise.resolve({ locale, token }) };
}

/** Pull the raw Set-Cookie header (the wire form the browser parses). */
function rawSetCookie(res: Response): string | null {
  return res.headers.get('set-cookie');
}

describe('contractor share-token exchange — happy path cookie attributes', () => {
  it('R1) valid token (exp 2 days out) → 303 redirect + httpOnly + SameSite=Lax + Path=/ cookie', async () => {
    const exp = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const token = jwtWithExp(exp);
    const res = await GET(mockReq(), ctx(token));

    expect(res.status).toBe(303);

    const raw = rawSetCookie(res);
    expect(raw, 'a Set-Cookie header MUST be present on the happy path').not.toBeNull();
    const sc = raw!;

    // ── The load-bearing attribute assertions. A MISSING flag here is
    //    the whole vulnerability this slice closes. Assert each concretely.
    expect(sc, 'cookie name + token value').toContain(`${COOKIE_NAME}=${token}`);
    expect(sc, 'HttpOnly — token must NOT be JS-readable (XSS exfil defense)').toMatch(
      /;\s*HttpOnly/i,
    );
    expect(sc, 'SameSite=Lax — CSRF / cross-site leak defense').toMatch(/;\s*SameSite=lax/i);
    expect(sc, 'Path=/ — cookie must reach BOTH the clean page and /api/v1/contractor/*').toMatch(
      /;\s*Path=\//i,
    );
    // NOTE on Secure: under vitest NODE_ENV='test' the handler's SECURE
    // constant is FALSE (mirrors local dev — a Secure cookie can't be set
    // over http://localhost). So the test-env cookie has no `Secure` token.
    // The PROD `Secure` guarantee is pinned separately in R1-prod below by
    // re-importing the module with NODE_ENV='production'.
    expect(sc, 'test env (NODE_ENV=test) intentionally omits Secure').not.toMatch(/;\s*Secure/i);
  });

  it('R1-prod) with NODE_ENV=production the cookie IS Secure (the prod guarantee)', async () => {
    // SECURE is evaluated at module load, so we must reset + re-import the
    // module under the production env to observe the real prod attribute.
    // `vi.unstubAllEnvs()` (afterEach) restores NODE_ENV.
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const mod = await import('./route');
    const exp = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const res = await mod.GET(mockReq(), ctx(jwtWithExp(exp)));
    const sc = rawSetCookie(res)!;
    expect(sc, 'PROD: Secure MUST be set — token never rides cleartext').toMatch(/;\s*Secure/i);
    // The other flags still hold in prod.
    expect(sc).toMatch(/;\s*HttpOnly/i);
    expect(sc).toMatch(/;\s*SameSite=lax/i);
  });

  it('R2) structured cookie record also carries httpOnly + SameSite=Lax + Path=/', async () => {
    const exp = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const res = await GET(mockReq(), ctx(jwtWithExp(exp)));
    // res.cookies.get returns the parsed ResponseCookie.
    const c = (
      res as unknown as {
        cookies: {
          get: (n: string) =>
            | undefined
            | {
                httpOnly?: boolean;
                secure?: boolean;
                sameSite?: string;
                path?: string;
                maxAge?: number;
              };
        };
      }
    ).cookies.get(COOKIE_NAME);
    expect(c, 'cookie must be set').toBeTruthy();
    expect(c!.httpOnly).toBe(true);
    expect(String(c!.sameSite).toLowerCase()).toBe('lax');
    expect(c!.path).toBe('/');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('contractor share-token exchange — Max-Age is DERIVED from exp, never extended', () => {
  it('R3) exp ~2 days out → Max-Age ≈ 2 days (NOT the 30-day ceiling)', async () => {
    const remaining = 2 * 24 * 60 * 60; // 2 days
    const exp = Math.floor(Date.now() / 1000) + remaining;
    const res = await GET(mockReq(), ctx(jwtWithExp(exp)));

    const sc = rawSetCookie(res)!;
    const m = sc.match(/Max-Age=(\d+)/i);
    expect(m, 'Max-Age must be present').not.toBeNull();
    const maxAge = Number(m![1]);

    // Must be the REMAINING TTL (±5s for execution skew), and crucially
    // must NOT have been inflated up to the 30-day ceiling.
    expect(maxAge).toBeGreaterThan(remaining - 5);
    expect(maxAge).toBeLessThanOrEqual(remaining);
    expect(maxAge, 'a 2-day token must NOT yield a 30-day cookie (TTL extension bug)').toBeLessThan(
      THIRTY_DAYS_SEC,
    );
  });

  it('R4) exp far in the future (1 year) → Max-Age CLAMPED to ≤ 30 days', async () => {
    const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year
    const res = await GET(mockReq(), ctx(jwtWithExp(exp)));

    const sc = rawSetCookie(res)!;
    const maxAge = Number(sc.match(/Max-Age=(\d+)/i)![1]);
    // The hard ceiling: a forged/garbled token claiming a huge exp must
    // not let the cookie outlive the locked 30-day TTL.
    expect(maxAge).toBeLessThanOrEqual(THIRTY_DAYS_SEC);
    // And it should be AT the ceiling (clamped), not something tiny.
    expect(maxAge).toBeGreaterThan(THIRTY_DAYS_SEC - 5);
  });

  it('R5) ALREADY-EXPIRED exp → NO cookie set + redirect to the clean view', async () => {
    const exp = Math.floor(Date.now() / 1000) - 60; // expired 1 min ago
    const res = await GET(mockReq(), ctx(jwtWithExp(exp)));

    expect(res.status).toBe(303);
    expect(rawSetCookie(res), 'an expired token must NEVER set a cookie').toBeNull();
    // Redirect to the clean, token-less error view.
    expect(res.headers.get('location')).toBe('https://app.emapp.io/he/contractor/share');
  });

  it('R6) exp present but NOT a number (string) → treated as unreadable → NO cookie', async () => {
    // The handler types exp as `unknown` and requires typeof === 'number'.
    const header = b64url(JSON.stringify({ alg: 'HS256' }));
    const payload = b64url(JSON.stringify({ exp: '9999999999' })); // string, not number
    const token = `${header}.${payload}.c2ln`;
    const res = await GET(mockReq(), ctx(token));
    expect(res.status).toBe(303);
    expect(rawSetCookie(res), 'non-numeric exp must not set a cookie').toBeNull();
  });

  it('R7) valid shape but NO exp claim → unreadable TTL → NO cookie (guard rejects over-aged anyway)', async () => {
    const res = await GET(mockReq(), ctx(jwtWithExp(undefined)));
    expect(res.status).toBe(303);
    expect(rawSetCookie(res), 'missing exp must not set a cookie').toBeNull();
  });
});

describe('contractor share-token exchange — token never leaks into the redirect Location', () => {
  it('R8) redirect Location is the CLEAN token-less URL — token string absent from Location', async () => {
    const exp = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const token = jwtWithExp(exp);
    const res = await GET(mockReq(), ctx(token));

    const loc = res.headers.get('location')!;
    expect(loc).toBe('https://app.emapp.io/he/contractor/share');
    // THE anti-leak assertion: the token must not survive into the
    // address bar via the redirect target (history / Referer leak).
    expect(loc.includes(token), 'token must NOT appear anywhere in the redirect Location').toBe(
      false,
    );
    // No query string either (no ?token=...).
    expect(loc).not.toContain('?');
    expect(loc).not.toContain(token.slice(0, 12));
  });

  it('R9) locale is preserved in the clean URL (en token → /en/contractor/share)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const res = await GET(mockReq('/en/contractor/share/x'), ctx(jwtWithExp(exp), 'en'));
    expect(res.headers.get('location')).toBe('https://app.emapp.io/en/contractor/share');
  });

  it('R10) bogus locale (not he|en) falls back to default he in the clean URL', async () => {
    const exp = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    const res = await GET(mockReq('/zz/contractor/share/x'), ctx(jwtWithExp(exp), 'zz'));
    // safeLocale clamps to routing.defaultLocale ('he').
    expect(res.headers.get('location')).toBe('https://app.emapp.io/he/contractor/share');
  });
});

describe('contractor share-token exchange — malformed / non-JWT tokens (no oracle)', () => {
  it('R11) non-JWT single segment → NO cookie + 303 to clean view', async () => {
    const res = await GET(mockReq('/he/contractor/share/notajwt'), ctx('notajwt'));
    expect(res.status).toBe(303);
    expect(rawSetCookie(res)).toBeNull();
    expect(res.headers.get('location')).toBe('https://app.emapp.io/he/contractor/share');
  });

  it('R12) two-segment (header.payload, no signature) → NOT JWT shape → NO cookie', async () => {
    const res = await GET(mockReq(), ctx('aGVhZGVy.cGF5bG9hZA'));
    expect(res.status).toBe(303);
    expect(rawSetCookie(res)).toBeNull();
  });

  it('R13) garbage payload segment (not base64url JSON) → NO cookie (decode throws → caught → null)', async () => {
    // Three segments so JWT_SHAPE passes, but the payload is not valid
    // base64url JSON → remainingTtlSeconds catches + returns null.
    const token = 'aaa.@@@notbase64@@@.ccc';
    // '@' is outside the JWT_SHAPE charset, so this actually fails the
    // shape test first — still NO cookie. Use a shape-valid-but-garbage
    // payload to exercise the JSON.parse catch path:
    const shapeValidGarbage = `${b64url('x')}.${b64url('not json at all }{')}.${b64url('s')}`;
    void token;
    const res = await GET(mockReq(), ctx(shapeValidGarbage));
    expect(res.status).toBe(303);
    expect(rawSetCookie(res), 'un-parseable payload must not set a cookie').toBeNull();
  });

  it('R14) malformed token gives the SAME response shape as a valid-but-expired one (no oracle)', async () => {
    // Anti-enumeration: an attacker probing tokens must not be able to
    // distinguish "malformed" from "expired" from the response. Both →
    // 303 to the same clean URL, no cookie.
    const expired = jwtWithExp(Math.floor(Date.now() / 1000) - 60);
    const malformed = 'notajwt';
    const a = await GET(mockReq(), ctx(expired));
    const b = await GET(mockReq(), ctx(malformed));
    expect(a.status).toBe(b.status);
    expect(rawSetCookie(a)).toBe(rawSetCookie(b)); // both null
    expect(a.headers.get('location')).toBe(b.headers.get('location'));
  });
});

describe('contractor share-token exchange — source-level anti-leak invariants', () => {
  it('R15) the handler never writes the token into a query param / address-bar surface', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'route.ts'), 'utf8');

    // cleanUrl.search is explicitly emptied — no token smuggled into ?query.
    expect(src).toMatch(/cleanUrl\.search\s*=\s*''/);
    // The cookie is set httpOnly (not JS-readable). Pin the literal so a
    // future edit that drops httpOnly trips this test.
    expect(src).toMatch(/httpOnly:\s*true/);
    expect(src).toMatch(/sameSite:\s*'lax'/);
    // maxAge is the DERIVED ttl, never a hard-coded 30-day literal passed
    // straight to the cookie (would extend TTL). The literal ceiling
    // MAX_COOKIE_AGE_SEC is only used inside Math.min (the clamp).
    expect(src).toMatch(/maxAge:\s*ttl/);
    expect(src).toMatch(/Math\.min\(remaining,\s*MAX_COOKIE_AGE_SEC\)/);
  });

  it('R16) the CLEAN page (../page.tsx) reads NO token from params/URL/storage — cookie is the sole credential', async () => {
    // Item #2: after the exchange, the token must live ONLY in the httpOnly
    // cookie. The clean view must not re-read it from the address bar (no
    // useParams/useSearchParams/window.location token) nor from JS storage.
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const rawPage = readFileSync(join(here, '..', 'page.tsx'), 'utf8');
    // Strip comments — the page's JSDoc legitimately discusses "the token"
    // (explaining it is NO LONGER in the URL). Assert on executable CODE.
    const page = rawPage.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // No reading the token back out of the URL on the clean view.
    expect(page).not.toMatch(/useParams/);
    expect(page).not.toMatch(/useSearchParams/);
    expect(page).not.toMatch(/window\.location/);
    // The exported component takes NO props/params (no `{ params }` arg) —
    // there is no `token` to thread anywhere.
    expect(page).toMatch(/export default function ContractorSharePage\(\)/);
    // No token argument threaded into the API getters (they are zero-arg).
    expect(page).toMatch(/getContractorProject\(\)/);
    expect(page).not.toMatch(/getContractorProject\([^)]+\)/);
    // No JS-readable token storage (httpOnly cookie can't be read here anyway).
    expect(page).not.toMatch(/localStorage/);
    expect(page).not.toMatch(/sessionStorage/);
    expect(page).not.toMatch(/document\.cookie/);
    // No `token` identifier remains in the executable code of the clean view.
    expect(page).not.toMatch(/\btoken\b/);
  });
});
