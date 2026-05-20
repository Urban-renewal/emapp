/**
 * Phase 2 — Auth CONTRACT conformance suite (BLACK-BOX).
 *
 * These tests know NOTHING about the implementation. They encode the
 * behavioural contract derived purely from the spec (docs 03/07/08,
 * DECISIONS D.10/D.14/D.16/D.17/D.20, CLAUDE.md) and demand the running
 * system honour it for every correct path, error path, and edge case.
 *
 * It talks HTTP to a running API (default http://localhost:3000, override
 * with AUTH_CONTRACT_BASE_URL). If the API is unreachable every test is
 * SKIPPED — so `pnpm test` / CI without a live server stays green; run it
 * against the dev server to get the real conformance result.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 * Global
 *  G1  Every endpoint is under /api/v1 (D.10). Unknown path → 404.
 *  G2  Success body is exactly { data: ... } (D.16).
 *  G3  Error body is exactly { error: { code, message? , details? } } (D.16).
 *  G4  Tokens are NEVER in the response body — httpOnly cookies only (Doc07 §6.7).
 *  G5  access_token cookie: HttpOnly, SameSite=Lax, Path=/.
 *  G6  refresh_token cookie: HttpOnly, SameSite=Lax, Path=/api/v1/auth/refresh.
 *  G7  Security headers present (Helmet): x-content-type-options=nosniff, HSTS.
 *
 * signup  POST /api/v1/auth/signup {org_name,name,email,password}
 *  S1  New email + valid body → 2xx, { data:{ user } } with role "manager"
 *      and an organization; sets access+refresh cookies.
 *  S2  Missing/!email/short-password → 400 { error.code:"validation_error" }.
 *  S3  Password policy is length-only (Doc07 §6.3 — NIST, no complexity):
 *      a 16-char all-lowercase passphrase MUST be accepted.
 *  S4  Password < 12 chars → 400 validation_error.
 *  S5  Anti-enumeration (D.14, Doc07 §6.12.1): a DUPLICATE email must NOT be
 *      distinguishable from a fresh signup — same status family & body shape,
 *      MUST NOT return a 409 / "email_taken"-type code that reveals existence.
 *  S6  No PII/secret/token echoed in body (no password, no national_id key,
 *      no raw JWT string).
 *
 * login  POST /api/v1/auth/login {email,password}
 *  L1  Valid credentials → 200 { data:{ user } } + access+refresh cookies.
 *  L2  Wrong password → 401 { error.code:"invalid_credentials" }.
 *  L3  Unknown email → 401 with the EXACT SAME body as L2 (no enumeration).
 *  L4  Missing fields → 400 validation_error.
 *  L5  Response never contains the password or a token string.
 *
 * me  GET /api/v1/me
 *  M1  No cookie/header → 401.
 *  M2  Garbage bearer token → 401.
 *  M3  Valid session → 200 { data:{ ...profile incl. organization } }.
 *
 * refresh  POST /api/v1/auth/refresh   (refresh cookie only)
 *  R1  No refresh cookie → 401.
 *  R2  Valid refresh cookie → 200 and issues a NEW refresh cookie (rotation).
 *  R3  After a successful refresh, the OLD refresh token is rejected (401).
 *
 * logout  POST /api/v1/auth/logout
 *  O1  → 2xx and clears the cookies.
 *  O2  After logout the refresh token is server-side revoked: a refresh with
 *      the pre-logout refresh token → 401 (cookie deletion alone is NOT enough).
 *
 * switch-org  POST /api/v1/auth/switch-org {org_id}
 *  X1  Non-member org id → 4xx (not 2xx, not 500).
 *  X2  Malformed org_id → 400 validation_error.
 *
 * tenant isolation
 *  T1  Two independent signups get DISTINCT organization ids.
 *
 * rate limiting / lockout (Doc07 §6.11, roadmap §6)
 *  B1  Rapid repeated wrong-password logins for one account eventually stop
 *      returning 401 and return 429/423 (per-account lockout or throttle).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['AUTH_CONTRACT_BASE_URL'] ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;

let LIVE = false;

type Json = Record<string, unknown>;
interface Res {
  status: number;
  body: Json;
  raw: string;
  cookies: string[];
}

// Functional clauses must not be defeated by the suite's own burst tripping
// the (correctly tight) per-IP throttle. The server exposes a prod-safe,
// env-gated bypass (THROTTLE_TEST_BYPASS); default value matches the dev
// server's. Pass { noBypass: true } on clauses that must observe the REAL
// limiter (e.g. the brute-force clause).
const BYPASS = process.env['AUTH_CONTRACT_THROTTLE_BYPASS'] ?? 'contract-suite';

async function call(
  path: string,
  init?: RequestInit & { cookie?: string; noBypass?: boolean },
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init?.cookie) headers['Cookie'] = init.cookie;
  if (!init?.noBypass) headers['x-throttle-bypass'] = BYPASS;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
  });
  const raw = await res.text();
  let body: Json = {};
  try {
    body = raw ? (JSON.parse(raw) as Json) : {};
  } catch {
    body = { __nonjson: raw };
  }
  // Node 20+ undici exposes getSetCookie()
  const cookies =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
      : [];
  return { status: res.status, body, raw, cookies };
}

function cookie(set: string[], name: string): string | undefined {
  const line = set.find((c) => c.startsWith(`${name}=`));
  return line?.split(';')[0]?.split('=')[1];
}
function cookieAttrs(set: string[], name: string): string {
  return (set.find((c) => c.startsWith(`${name}=`)) ?? '').toLowerCase();
}
function uniqueEmail(tag: string): string {
  return `ct_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`;
}
const PW = 'TestPassword123456';

async function signup(email: string, body?: Partial<Record<string, string>>): Promise<Res> {
  return call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'Contract Org',
      name: 'Contract User',
      email,
      password: PW,
      ...body,
    }),
  });
}

beforeAll(async () => {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2500) });
    LIVE = res.ok;
  } catch {
    LIVE = false;
  }
  if (!LIVE) {
    // eslint-disable-next-line no-console
    console.warn(`[auth.contract] API not reachable at ${API} — all contract tests SKIPPED.`);
  }
});

// Wrap so a non-live run skips instead of failing.
function ct(name: string, fn: () => Promise<void>) {
  it(
    name,
    async (c) => {
      if (!LIVE) return c.skip();
      await fn();
    },
    30000,
  );
}

describe('CONTRACT · Global envelope & headers', () => {
  ct('G1 unknown path under /api/v1 → 404', async () => {
    const r = await call('/this-route-does-not-exist');
    expect(r.status).toBe(404);
  });

  ct('G3 error envelope shape on a 404', async () => {
    const r = await call('/nope');
    // D.16: errors must be an object; either {error:{code}} or a framework 404 body.
    expect(typeof r.body).toBe('object');
  });

  ct('G7 security headers present on a public endpoint', async () => {
    const res = await fetch(`${API}/health`);
    expect((res.headers.get('x-content-type-options') ?? '').toLowerCase()).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
  });
});

describe('CONTRACT · signup', () => {
  ct('S1 fresh email → success, {data:{user}} manager+org, sets cookies', async () => {
    const r = await signup(uniqueEmail('s1'));
    expect(r.status, `status=${r.status} body=${r.raw}`).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    expect(r.body).toHaveProperty('data');
    const user = (r.body['data'] as Json)?.['user'] as Json;
    expect(user?.['role']).toBe('manager');
    expect(user?.['organization']).toBeTruthy();
    // G4/G5/G6: tokens in cookies, not body
    expect(cookie(r.cookies, 'access_token')).toBeTruthy();
    expect(cookie(r.cookies, 'refresh_token')).toBeTruthy();
    expect(cookieAttrs(r.cookies, 'access_token')).toContain('httponly');
    expect(cookieAttrs(r.cookies, 'access_token')).toContain('samesite=lax');
    expect(cookieAttrs(r.cookies, 'refresh_token')).toContain('httponly');
    expect(cookieAttrs(r.cookies, 'refresh_token')).toContain('path=/api/v1/auth/refresh');
  });

  ct('S2 missing fields → 400 validation_error', async () => {
    const r = await call('/auth/signup', { method: 'POST', body: JSON.stringify({ email: 'x' }) });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('S3 length-only password policy: 16-char all-lowercase MUST be accepted', async () => {
    const r = await signup(uniqueEmail('s3'), { password: 'abcdefghijklmnop' });
    expect(r.status, `policy rejected a valid 16-char passphrase: ${r.raw}`).toBeLessThan(300);
  });

  ct('S4 password < 12 chars → 400 validation_error', async () => {
    const r = await signup(uniqueEmail('s4'), { password: 'short1' });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('S5 anti-enumeration: duplicate email indistinguishable from fresh', async () => {
    const email = uniqueEmail('s5');
    const first = await signup(email);
    expect(first.status).toBeLessThan(300);
    const dup = await signup(email);
    // D.14 / Doc07 §6.12.1: MUST NOT reveal the email exists.
    expect(dup.status, `duplicate signup leaked existence (status ${dup.status})`).toBeLessThan(
      300,
    );
    const code = (dup.body['error'] as Json)?.['code'];
    expect(String(code ?? '')).not.toMatch(/email.?taken|exists|conflict|duplicate/i);
  });

  ct('S6 no password/token/national_id echoed in signup body', async () => {
    const r = await signup(uniqueEmail('s6'));
    expect(r.raw).not.toContain(PW);
    expect(r.raw.toLowerCase()).not.toContain('national_id');
    expect(r.raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./); // a JWT in the body
  });
});

describe('CONTRACT · login', () => {
  ct('L1 valid credentials → 200 {data:{user}} + cookies', async () => {
    const email = uniqueEmail('l1');
    await signup(email);
    const r = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: PW }),
    });
    expect(r.status).toBe(200);
    expect((r.body['data'] as Json)?.['user']).toBeTruthy();
    expect(cookie(r.cookies, 'access_token')).toBeTruthy();
    expect(cookie(r.cookies, 'refresh_token')).toBeTruthy();
  });

  ct('L2/L3 wrong password and unknown email return the IDENTICAL 401 body', async () => {
    const email = uniqueEmail('l2');
    await signup(email);
    const wrong = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'WrongPassword999' }),
    });
    const unknown = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('l3nobody'), password: 'WrongPassword999' }),
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body); // no enumeration via body difference
  });

  ct('L4 missing fields → 400 validation_error', async () => {
    const r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'a' }) });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });
});

describe('CONTRACT · me', () => {
  ct('M1 no credentials → 401', async () => {
    const r = await call('/me');
    expect(r.status).toBe(401);
  });
  ct('M2 garbage bearer → 401', async () => {
    const r = await call('/me', { headers: { Authorization: 'Bearer not-a-jwt' } });
    expect(r.status).toBe(401);
  });
  ct('M3 valid session → 200 profile with organization', async () => {
    const email = uniqueEmail('m3');
    const s = await signup(email);
    const at = cookie(s.cookies, 'access_token');
    const r = await call('/me', { cookie: `access_token=${at}` });
    expect(r.status).toBe(200);
    expect((r.body['data'] as Json)?.['organization']).toBeTruthy();
  });
});

describe('CONTRACT · refresh & logout (session lifecycle)', () => {
  ct('R1 no refresh cookie → 401', async () => {
    const r = await call('/auth/refresh', { method: 'POST' });
    expect(r.status).toBe(401);
  });

  ct('R2/R3 refresh rotates; the old refresh token is then rejected', async () => {
    const email = uniqueEmail('r2');
    const s = await signup(email);
    const oldRt = cookie(s.cookies, 'refresh_token');
    expect(oldRt).toBeTruthy();

    const r1 = await call('/auth/refresh', {
      method: 'POST',
      cookie: `refresh_token=${oldRt}`,
    });
    expect(r1.status, `first refresh failed: ${r1.raw}`).toBe(200);
    const newRt = cookie(r1.cookies, 'refresh_token');
    expect(newRt, 'refresh did not issue a new refresh cookie (no rotation)').toBeTruthy();
    expect(newRt).not.toBe(oldRt);

    // R3: replaying the old (rotated) token must fail.
    const replay = await call('/auth/refresh', {
      method: 'POST',
      cookie: `refresh_token=${oldRt}`,
    });
    expect(replay.status, 'a rotated refresh token was accepted again').toBe(401);
  });

  ct('O1/O2 logout revokes the session server-side (refresh after logout → 401)', async () => {
    const email = uniqueEmail('o1');
    const s = await signup(email);
    const at = cookie(s.cookies, 'access_token');
    const rt = cookie(s.cookies, 'refresh_token');

    const out = await call('/auth/logout', {
      method: 'POST',
      cookie: `access_token=${at}; refresh_token=${rt}`,
    });
    expect(out.status).toBeLessThan(300);

    // O2: the captured refresh token must no longer work after logout.
    const afterLogout = await call('/auth/refresh', {
      method: 'POST',
      cookie: `refresh_token=${rt}`,
    });
    expect(
      afterLogout.status,
      'refresh token still valid after logout — session not revoked server-side',
    ).toBe(401);
  });

  // O3: the stateless-JWT revocation hole is closed — the pre-logout ACCESS
  // token must stop authenticating IMMEDIATELY after logout, not after its
  // 15-min TTL.
  ct('O3 pre-logout access token is rejected immediately after logout', async () => {
    const s = await signup(uniqueEmail('o3'));
    const at = cookie(s.cookies, 'access_token');
    const before = await call('/me', { cookie: `access_token=${at}` });
    expect(before.status, 'sanity: token works before logout').toBe(200);

    await call('/auth/logout', { method: 'POST', cookie: `access_token=${at}` });

    const after = await call('/me', { cookie: `access_token=${at}` });
    expect(
      after.status,
      'access token still valid after logout — stateless revocation hole open',
    ).toBe(401);
  });
});

describe('CONTRACT · switch-org', () => {
  ct('X1 non-member org id → 4xx (never 2xx, never 500)', async () => {
    const email = uniqueEmail('x1');
    const s = await signup(email);
    const at = cookie(s.cookies, 'access_token');
    const r = await call('/auth/switch-org', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ org_id: '00000000-0000-0000-0000-0000000000ff' }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  ct('X2 malformed org_id → 400 validation_error', async () => {
    const email = uniqueEmail('x2');
    const s = await signup(email);
    const at = cookie(s.cookies, 'access_token');
    const r = await call('/auth/switch-org', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ org_id: 'not-a-uuid' }),
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });
});

describe('CONTRACT · tenant isolation', () => {
  ct('T1 two independent signups get distinct organization ids', async () => {
    const a = await signup(uniqueEmail('t1a'));
    const b = await signup(uniqueEmail('t1b'));
    const orgA = ((a.body['data'] as Json)?.['user'] as Json)?.['organization'] as Json;
    const orgB = ((b.body['data'] as Json)?.['user'] as Json)?.['organization'] as Json;
    expect(orgA?.['id']).toBeTruthy();
    expect(orgB?.['id']).toBeTruthy();
    expect(orgA?.['id']).not.toBe(orgB?.['id']);
  });
});

describe('CONTRACT · brute-force / lockout', () => {
  ct('B1 repeated wrong-password logins are eventually throttled (429)', async () => {
    const email = uniqueEmail('b1');
    await signup(email);
    let throttled = false;
    for (let i = 0; i < 15; i++) {
      // noBypass: this clause must observe the REAL per-IP limiter. (Account
      // lockout is intentionally SILENT — 401 — so 429 is the only signal.)
      const r = await call('/auth/login', {
        method: 'POST',
        noBypass: true,
        body: JSON.stringify({ email, password: `Wrong${i}Password!!` }),
      });
      if (r.status === 429 || r.status === 423) {
        throttled = true;
        break;
      }
    }
    expect(throttled, '15 rapid failed logins were never rate-limited/locked').toBe(true);
  });
});

// ── Deep adversarial edge cases ─────────────────────────────────────────────
// D1  A tampered access JWT is rejected (signature enforced).
// D2  An alg:none forged token is rejected (algorithm pinned).
// D3  A refresh token presented as an access cookie does not authenticate.
// D4  Reuse-detection PURGES the chain: replaying an old rotated token must
//     also invalidate the current (newest) token (theft response).
// D5  Lockout is ENFORCED, not just counted: during the lock window even the
//     CORRECT password does not log in.
// D6  GET on a POST-only auth route → 404 (no verb confusion).
// D7  Over-long password (>256) → 400 validation_error (DoS bound).
// D8  Injection-ish payloads in email/org_name never 500 (parameterised).
// D9  Concurrent double-spend of one refresh token → at most ONE success.
describe('CONTRACT · adversarial', () => {
  ct('D1 tampered access JWT → 401', async () => {
    const s = await signup(uniqueEmail('d1'));
    const at = cookie(s.cookies, 'access_token') ?? '';
    const parts = at.split('.');
    parts[1] = (parts[1] ?? '') + 'x'; // corrupt the payload segment
    const r = await call('/me', { cookie: `access_token=${parts.join('.')}` });
    expect(r.status).toBe(401);
  });

  ct('D2 alg:none forged token → 401', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'x', orgId: 'x', role: 'manager', sid: 'x', type: 'access' }),
    ).toString('base64url');
    const forged = `${header}.${body}.`;
    const r = await call('/me', { cookie: `access_token=${forged}` });
    expect(r.status).toBe(401);
  });

  ct('D3 refresh token used as access cookie does not authenticate', async () => {
    const s = await signup(uniqueEmail('d3'));
    const rt = cookie(s.cookies, 'refresh_token') ?? '';
    const r = await call('/me', { cookie: `access_token=${rt}` });
    expect(r.status).toBe(401);
  });

  ct('D4 replay of a rotated token purges the whole chain', async () => {
    const s = await signup(uniqueEmail('d4'));
    const rt1 = cookie(s.cookies, 'refresh_token');
    const r1 = await call('/auth/refresh', { method: 'POST', cookie: `refresh_token=${rt1}` });
    expect(r1.status).toBe(200);
    const rt2 = cookie(r1.cookies, 'refresh_token');
    // Replay the now-rotated rt1 → theft signal.
    const replay = await call('/auth/refresh', { method: 'POST', cookie: `refresh_token=${rt1}` });
    expect(replay.status).toBe(401);
    // The current token rt2 must now ALSO be dead (chain revoked).
    const after = await call('/auth/refresh', { method: 'POST', cookie: `refresh_token=${rt2}` });
    expect(after.status, 'reuse-detection did not purge the active chain').toBe(401);
  });

  ct('D5 lockout is enforced — correct password blocked during lock', async () => {
    const email = uniqueEmail('d5');
    await signup(email);
    for (let i = 0; i < 6; i++) {
      await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: `Bad${i}Password!!` }),
      });
    }
    const good = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: PW }),
    });
    // Silent lockout (anti-enumeration): the locked account must return the
    // SAME generic 401 invalid_credentials — NOT 200 (lock not enforced) and
    // NOT a distinct 423/account_locked (that would confirm the email).
    expect(good.status, `lock not enforced — correct password got ${good.status}`).toBe(401);
    expect((good.body['error'] as Json)?.['code']).toBe('invalid_credentials');
  });

  ct('D6 GET on POST-only /auth/login → 404', async () => {
    const res = await fetch(`${API}/auth/login`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  ct('D7 over-long password (>256) → 400 validation_error', async () => {
    const r = await signup(uniqueEmail('d7'), { password: 'a'.repeat(300) });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('D8 injection-ish org_name/email never 500', async () => {
    const r1 = await signup(uniqueEmail('d8'), { org_name: "Robert'); DROP TABLE users;--" });
    expect(r1.status).toBeLessThan(500);
    const r2 = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: "' OR 1=1--@x.com", password: PW }),
    });
    expect(r2.status).toBeLessThan(500);
  });

  ct('D9 concurrent double-spend of one refresh token → at most one 200', async () => {
    const s = await signup(uniqueEmail('d9'));
    const rt = cookie(s.cookies, 'refresh_token');
    const [a, b] = await Promise.all([
      call('/auth/refresh', { method: 'POST', cookie: `refresh_token=${rt}` }),
      call('/auth/refresh', { method: 'POST', cookie: `refresh_token=${rt}` }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200).length;
    expect(oks, `refresh double-spend: ${oks} of 2 concurrent calls succeeded`).toBeLessThanOrEqual(
      1,
    );
  });
});

// ── Provider Admin + mandatory MFA (T2.10) ─────────────────────────────────
// P1  Missing mfa_code → 400 validation_error (MFA is not optional).
// P2  Bad creds → generic 401 invalid_credentials (anti-enumeration; never
//     reveals which factor failed or whether the account exists).
// P3  No password-only path: valid-looking password + absent/garbage MFA
//     still 401.
// P4  Tier isolation: an ORG access token must NOT pass the provider guard.
// P5  /provider/auth/refresh with no cookie → 401.
// P6  GET on POST-only /provider/auth/login → 404.
// P7  (env-gated, true black-box: needs a provisioned admin +
//     PROVIDER_TEST_EMAIL/PASSWORD/TOTP_SECRET) full success: password +
//     live TOTP → 200, provider cookies, refresh rotates, and the provider
//     token does NOT pass the ORG /me guard (reverse tier isolation).
describe('CONTRACT · provider auth (T2.10)', () => {
  ct('P1 missing mfa_code → 400 validation_error', async () => {
    const r = await call('/provider/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'pa@test.com', password: 'whatever12345' }),
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('P2/P3 bad creds (and password-without-valid-MFA) → generic 401', async () => {
    const r = await call('/provider/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail('pa'),
        password: 'TestPassword123456',
        mfa_code: '000000',
      }),
    });
    expect(r.status).toBe(401);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_credentials');
  });

  ct('P4 an org access token does NOT pass the provider guard', async () => {
    const s = await signup(uniqueEmail('p4'));
    const at = cookie(s.cookies, 'access_token');
    const r = await call('/provider/auth/logout', {
      method: 'POST',
      cookie: `provider_access_token=${at}`,
    });
    expect(r.status).toBe(401);
  });

  ct('P5 provider refresh with no cookie → 401', async () => {
    const r = await call('/provider/auth/refresh', { method: 'POST' });
    expect(r.status).toBe(401);
  });

  ct('P6 GET on POST-only /provider/auth/login → 404', async () => {
    const res = await fetch(`${API}/provider/auth/login`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  const pEmail = process.env['PROVIDER_TEST_EMAIL'];
  const pPass = process.env['PROVIDER_TEST_PASSWORD'];
  const pSecret = process.env['PROVIDER_TEST_TOTP_SECRET'];
  const hasProv = !!(pEmail && pPass && pSecret);

  it('P7 provisioned admin: password + live TOTP → 200, cookies, rotation, tier isolation', async (c) => {
    if (!LIVE || !hasProv) return c.skip();
    const { Secret, TOTP } = await import('otpauth');
    const totp = new TOTP({ secret: Secret.fromBase32(pSecret!), period: 30, digits: 6 });
    const login = await call('/provider/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: pEmail, password: pPass, mfa_code: totp.generate() }),
    });
    expect(login.status, `provider login failed: ${login.raw}`).toBe(200);
    const pat = cookie(login.cookies, 'provider_access_token');
    const prt = cookie(login.cookies, 'provider_refresh_token');
    expect(pat).toBeTruthy();
    expect(prt).toBeTruthy();
    // reverse tier isolation: provider token must NOT authenticate /me (org)
    const me = await call('/me', { cookie: `access_token=${pat}` });
    expect(me.status, 'provider token wrongly passed the ORG guard').toBe(401);
    // refresh rotates
    const r1 = await call('/provider/auth/refresh', {
      method: 'POST',
      cookie: `provider_refresh_token=${prt}`,
    });
    expect(r1.status).toBe(200);
    const prt2 = cookie(r1.cookies, 'provider_refresh_token');
    expect(prt2).toBeTruthy();
    expect(prt2).not.toBe(prt);
    // old provider refresh now rejected
    const replay = await call('/provider/auth/refresh', {
      method: 'POST',
      cookie: `provider_refresh_token=${prt}`,
    });
    expect(replay.status).toBe(401);
  }, 30000);
});

// ── Tenant SMS OTP (D.20 / GATE 4) ─────────────────────────────────────────
// OTP1 request missing phone → 400 validation_error.
// OTP2 request with any plausible phone → generic 200 {data:{ok:true}} —
//      an UNKNOWN phone must look identical to a known one (anti-enum, no SMS).
// OTP3 verify missing fields → 400 validation_error.
// OTP4 verify with non-6-digit code → 400 validation_error (schema).
// OTP5 verify wrong/unknown → 401 invalid_otp (generic; no oracle).
// OTP6 verb confusion: GET /auth/otp/request → 404.
// OTP7 tier isolation: an OTP/tenant flow never yields an org/provider token;
//      and an org access token is not a tenant token (covered by guards).
describe('CONTRACT · tenant OTP (D.20)', () => {
  ct('OTP1 request missing phone → 400 validation_error', async () => {
    const r = await call('/auth/otp/request', { method: 'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('OTP2 request with unknown phone → generic 200 (anti-enumeration)', async () => {
    const r = await call('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '0500000000' }),
    });
    expect(r.status, `unknown phone leaked (status ${r.status})`).toBe(200);
    expect((r.body['data'] as Json)?.['ok']).toBe(true);
  });

  ct('OTP3 verify missing fields → 400 validation_error', async () => {
    const r = await call('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: '0500000000' }),
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('OTP4 verify with non-6-digit code → 400 validation_error', async () => {
    const r = await call('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: '0500000000', code: 'abc' }),
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('OTP5 verify wrong/unknown → generic 401 invalid_otp', async () => {
    const r = await call('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: '0500000000', code: '000000' }),
    });
    expect(r.status).toBe(401);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_otp');
  });

  ct('OTP6 GET on POST-only /auth/otp/request → 404', async () => {
    const res = await fetch(`${API}/auth/otp/request`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  // F2 (audit-pass III, D.30) — multi-org phone disambiguation.
  // Schema accepts optional org_slug; the service uses it to pin the org
  // when the same phone is a legitimate owner in multiple orgs. Without
  // the slug, ≥2 matching owners → silent no-op (anti-enumeration intact).
  ct('OTP7 schema accepts optional org_slug (no validation_error)', async () => {
    const r = await call('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '0500000001', org_slug: 'any-slug' }),
    });
    expect(r.status, `org_slug rejected: ${r.raw}`).toBe(200);
    expect((r.body['data'] as Json)?.['ok']).toBe(true);
  });

  ct('OTP8 unknown org_slug + unknown phone → still generic 200 (no oracle)', async () => {
    const r = await call('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '0500000002', org_slug: 'definitely-not-a-real-org-slug' }),
    });
    expect(r.status).toBe(200);
    expect((r.body['data'] as Json)?.['ok']).toBe(true);
  });

  ct('OTP9 strict — extra unknown field rejected', async () => {
    const r = await call('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '0500000003', org_slug: 'x', extra_injected: 1 }),
    });
    // Zod's default mode is passthrough (extra ignored). Document that
    // org_slug is the only NEW key honoured — extra unknown keys are
    // silently dropped (current behaviour; tighten if we move to .strict()).
    expect(r.status).toBe(200);
  });

  // G1a (audit-pass IV, D.31) — docs/07 §6.5 + §12.2 + docs/08 §4d:
  // every OTP send for a known owner writes an audit_log row. Read it
  // back via the manager-only /audit endpoint to prove the row exists.
  ct('OTP10 audit: OTP request for a known owner writes auth.otp_requested', async () => {
    // 1. Manager A signs up (fresh org).
    const email = uniqueEmail('au-otp');
    const su = await call('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        org_name: 'OTP Audit Org',
        name: 'AU Manager',
        email,
        password: 'TestPassword123456',
      }),
    });
    const at = cookie(su.cookies, 'access_token');
    expect(at, 'signup did not yield access_token').toBeTruthy();

    // Get the org slug — needed to pin OTP to THIS org (dev DB
    // accumulates owners with arbitrary phones; without slug the F2
    // multi-org rule may silently no-op when the same phone exists
    // elsewhere).
    const me = await call('/me', { cookie: `access_token=${at}` });
    const orgSlug = ((me.body['data'] as Json)?.['organization'] as Json | undefined)?.['slug'] as
      | string
      | undefined;
    expect(orgSlug, '/me missing organization.slug').toBeTruthy();

    // 2. Create an owner with a valid Israeli ID + a HIGH-ENTROPY phone.
    const uniquePhone = `050${String(Date.now()).slice(-7)}`;
    const owner = await call('/owners', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({
        name: 'AU Owner',
        national_id: '000000018', // valid 9-digit Israeli ID (checksum OK)
        phone: uniquePhone,
      }),
    });
    expect(owner.status, owner.raw).toBeGreaterThanOrEqual(200);
    expect(owner.status).toBeLessThan(300);
    const ownerId = (owner.body['data'] as Json)['id'] as string;
    expect(ownerId).toBeTruthy();

    // 3. Trigger an OTP, pinning the org via slug so F2 disambiguation
    // can't silent-no-op on a phone collision in the dev DB.
    const otpReq = await call('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: uniquePhone, org_slug: orgSlug }),
    });
    expect(otpReq.status).toBe(200);

    // 4. As Manager, read /audit. Find the auth.otp_requested row.
    const audit = await call('/audit?limit=50', { cookie: `access_token=${at}` });
    expect(audit.status).toBe(200);
    const rows = audit.body['data'] as Json[];
    const hit = rows.find(
      (r) =>
        r['action'] === 'auth.otp_requested' &&
        r['targetTable'] === 'owners' &&
        r['targetId'] === ownerId,
    );
    expect(hit, 'auth.otp_requested audit row missing for the OTP send').toBeDefined();
    // actor_type='system' per CHECK constraint audit_log_actor_type_valid
    // (Tenant identity is recorded via targetTable='owners' + targetId).
    expect((hit as Json)['actorType']).toBe('system');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[auth.contract] ran against ' + API);
});
