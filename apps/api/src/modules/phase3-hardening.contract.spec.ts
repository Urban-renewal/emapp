/**
 * Phase 3 — DEEP HARDENING conformance suite (BLACK-BOX, adversarial).
 *
 * Written "as if the code is unknown": it asserts the *contract* the
 * platform must honour under abuse, NOT implementation details. Covers
 * what the per-entity contract specs do NOT: adversarial input / error
 * handling (never a 500, always the D.16 envelope), data-security / ISO
 * invariants (no PII / secret / pg-internal ever leaks), a SYSTEMATIC
 * cross-tenant no-oracle matrix, a concurrency race, and a CI-stable
 * latency regression guard. Skips if the API is unreachable; the CI
 * `conformance` job boots the compiled API and runs it for real.
 *
 * KNOWN COVERAGE LIMIT (reported, not hidden): the D.17 deny matrix for
 * viewer/agent cannot be exercised black-box — there is no API to
 * provision a non-manager user (no invite/membership endpoint in
 * Phase 3). That gap is a finding, recorded in PROGRESS, not faked here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['AUTH_CONTRACT_BASE_URL'] ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const BYPASS = process.env['AUTH_CONTRACT_THROTTLE_BYPASS'] ?? 'contract-suite';
let LIVE = false;

type Json = Record<string, unknown>;
interface Res {
  status: number;
  body: Json;
  raw: string;
  cookies: string[];
}

async function call(
  path: string,
  init?: RequestInit & { cookie?: string; rawBody?: string; noJson?: boolean },
): Promise<Res> {
  const headers: Record<string, string> = { 'x-throttle-bypass': BYPASS };
  if (!init?.noJson) headers['Content-Type'] = 'application/json';
  if (init?.cookie) headers['Cookie'] = init.cookie;
  const res = await fetch(`${API}${path}`, {
    ...init,
    body: init?.rawBody !== undefined ? init.rawBody : init?.body,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
  });
  const raw = await res.text();
  let body: Json = {};
  try {
    body = raw ? (JSON.parse(raw) as Json) : {};
  } catch {
    body = { __nonjson: raw };
  }
  const cookies =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
      : [];
  return { status: res.status, body, raw, cookies };
}
function cookie(set: string[], name: string): string | undefined {
  return set
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.split('=')[1];
}
function uniq(t: string): string {
  return `${t}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
const PW = 'TestPassword123456';

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'HARD Org',
      name: 'HARD User',
      email: `hard_${uniq(tag)}@contract.test`,
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  return at;
}
function validId(n: number): string {
  const e = String(n % 100000000).padStart(8, '0');
  let s = 0;
  for (let i = 0; i < 8; i++) {
    let d = Number(e[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    s += d;
  }
  return e + String((10 - (s % 10)) % 10);
}
let seed = 70_000_000 + Math.floor(Math.random() * 20_000_000);

// The hard ISO invariant: no response body, anywhere, may contain a raw
// JWT, a stack frame, a pg internal, a password, or an encryption key.
function assertNoSecretLeak(raw: string): void {
  expect(raw, 'JWT leaked in body').not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
  expect(raw, 'stack trace leaked').not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
  expect(raw.toLowerCase(), 'pg internal leaked').not.toMatch(
    /pg_sym|pgcrypto|current_setting|relation ".*" does not exist|syntax error at or near/,
  );
  expect(raw, 'password echoed').not.toContain(PW);
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
    console.warn(`[phase3.hardening] API not reachable — SKIPPED.`);
  }
});
function ct(name: string, fn: () => Promise<void>, timeout = 30000) {
  it(
    name,
    async (c) => {
      if (!LIVE) return c.skip();
      await fn();
    },
    timeout,
  );
}

describe('HARDENING · envelope & headers invariants', () => {
  ct('H1 unknown /api/v1 path → 404, object body, no secret leak', async () => {
    const r = await call('/this-does-not-exist-xyz');
    expect(r.status).toBe(404);
    expect(typeof r.body).toBe('object');
    assertNoSecretLeak(r.raw);
  });

  ct('H2 security headers present on a domain route', async () => {
    const at = await manager('hdr');
    const res = await fetch(`${API}/projects`, { headers: { Cookie: `access_token=${at}` } });
    expect((res.headers.get('x-content-type-options') ?? '').toLowerCase()).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
  });

  ct('H3 every error across sampled domain routes is D.16 {error:{code}}', async () => {
    const at = await manager('env');
    const probes = [
      await call('/projects/not-a-uuid', { cookie: `access_token=${at}` }),
      await call('/projects/00000000-0000-0000-0000-0000000000aa', {
        cookie: `access_token=${at}`,
      }),
      await call('/projects', {
        method: 'POST',
        cookie: `access_token=${at}`,
        body: JSON.stringify({}),
      }),
      await call('/owners?cursor=tampered', { cookie: `access_token=${at}` }),
    ];
    for (const p of probes) {
      expect(p.status).toBeGreaterThanOrEqual(400);
      const err = p.body['error'] as Json | undefined;
      expect(err, `not a D.16 error envelope: ${p.raw}`).toBeTruthy();
      expect(typeof err?.['code']).toBe('string');
      assertNoSecretLeak(p.raw);
    }
  });
});

describe('HARDENING · adversarial input never 500', () => {
  ct('H4 malformed JSON body → 4xx, never 5xx', async () => {
    const at = await manager('mj');
    const r = await call('/projects', {
      method: 'POST',
      cookie: `access_token=${at}`,
      rawBody: '{"name":"x", BROKEN',
    });
    expect(r.status, r.raw).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    assertNoSecretLeak(r.raw);
  });

  ct('H5 wrong Content-Type with JSON-ish text → 4xx, never 5xx', async () => {
    const at = await manager('ct');
    const r = await call('/projects', {
      method: 'POST',
      cookie: `access_token=${at}`,
      noJson: true,
      headers: { 'Content-Type': 'text/plain' },
      rawBody: JSON.stringify({ name: 'x', type: 'tama38_1' }),
    });
    expect(r.status).toBeLessThan(500);
  });

  ct('H6 oversized string (10k) → 400 validation_error', async () => {
    const at = await manager('big');
    const r = await call('/projects', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'a'.repeat(10_000), type: 'tama38_1' }),
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('H7 array over the documented max → 400 (DoS bound)', async () => {
    const at = await manager('arr');
    const r = await call('/projects', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({
        name: 'x',
        type: 'tama38_1',
        junk: Array.from({ length: 5000 }, (_, i) => i),
      }),
    });
    expect(r.status).toBe(400);
  });

  ct('H8 injection/XSS/unicode round-trip safe; NUL/bad-UTF8 → 400 (never 500)', async () => {
    const at = await manager('inj');
    const RTL = String.fromCharCode(0x202e); // bidi override (valid UTF-8)
    const NUL = String.fromCharCode(0); // pg-unstorable
    const LONE = String.fromCharCode(0xd800); // unpaired surrogate

    const storable = [
      "Robert'); DROP TABLE projects;--",
      '<script>alert(1)</script>',
      `proj ${RTL} reversed`,
      '\u{1F600} פרויקט \u{1F3D7}',
    ];
    for (const name of storable) {
      const r = await call('/projects', {
        method: 'POST',
        cookie: `access_token=${at}`,
        body: JSON.stringify({ name, type: 'tama38_1' }),
      });
      expect(r.status, `storable payload 500'd → ${r.raw}`).toBeLessThan(500);
      if (r.status < 300) expect((r.body['data'] as Json)['name']).toBe(name);
    }

    for (const bad of [`a${NUL}b`, `x${LONE}y`]) {
      const r = await call('/projects', {
        method: 'POST',
        cookie: `access_token=${at}`,
        body: JSON.stringify({ name: bad, type: 'tama38_1' }),
      });
      expect(r.status, `unstorable input not a clean 4xx → ${r.status}`).toBe(400);
      expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
    }
  });

  ct('H9 numeric edge cases on bounded fields → 400', async () => {
    const at = await manager('num');
    const big = await call('/projects', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'x', type: 'tama38_1', targetSignaturePct: 1e308 }),
    });
    expect(big.status).toBe(400);
    const neg = await call('/projects', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'x', type: 'tama38_1', targetSignaturePct: -5 }),
    });
    expect(neg.status).toBe(400);
  });

  ct('H10 verb confusion on POST-only routes never yields 2xx or 5xx', async () => {
    const anon = await fetch(`${API}/owners/search`, { method: 'GET' });
    expect(anon.status, 'verb confusion leaked 2xx/5xx (anon)').toBeGreaterThanOrEqual(400);
    expect(anon.status).toBeLessThan(500);
    const at = await manager('verb');
    const authed = await call('/owners/search', { cookie: `access_token=${at}` });
    expect(authed.status, `authed verb confusion → ${authed.status}`).toBeGreaterThanOrEqual(400);
    expect(authed.status).toBeLessThan(500);
    expect(authed.body).not.toHaveProperty('data');
  });

  ct('H11 cursor abuse variants → 400 invalid_cursor, never 500 / never data', async () => {
    const at = await manager('cur');
    for (const c of [
      'x',
      '%%%',
      Buffer.from('{"c":"not-a-date","i":"x"}').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
      'a'.repeat(5000),
    ]) {
      const r = await call(`/projects?cursor=${encodeURIComponent(c)}`, {
        cookie: `access_token=${at}`,
      });
      expect(r.status, `cursor "${c.slice(0, 12)}" → ${r.status}`).toBe(400);
      expect((r.body['error'] as Json)?.['code']).toBe('invalid_cursor');
    }
  });
});

describe('HARDENING · ISO data-security invariants', () => {
  ct('H12 clear PII never appears in owner create / list / search', async () => {
    const at = await manager('pii');
    const nid = validId(seed++);
    const phone = '0501234567';
    const oc = await call('/owners', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'PII Probe', national_id: nid, phone }),
    });
    expect(oc.status).toBeLessThan(300);
    const ownerId = (oc.body['data'] as Json)['id'] as string;
    const list = await call('/owners', { cookie: `access_token=${at}` });
    const search = await call('/owners/search', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ national_id: nid }),
    });
    for (const r of [oc, list, search]) {
      expect(r.raw.includes(nid), 'clear national_id leaked').toBe(false);
      expect(r.raw.includes('501234567'), 'clear phone leaked').toBe(false);
      assertNoSecretLeak(r.raw);
    }
    expect(ownerId).toBeTruthy();
  });

  ct('H13 audit read never exposes diffs/ip/ua and never clear PII', async () => {
    const at = await manager('aud');
    const nid = validId(seed++);
    await call('/owners', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'Audited', national_id: nid }),
    });
    const a = await call('/audit', { cookie: `access_token=${at}` });
    expect(a.status).toBe(200);
    expect(a.raw.includes(nid), 'clear national_id leaked into audit').toBe(false);
    for (const e of a.body['data'] as Json[]) {
      for (const k of ['beforeState', 'afterState', 'ip', 'userAgent']) {
        expect(e, `audit leaked ${k}`).not.toHaveProperty(k);
      }
    }
  });
});

describe('HARDENING · systematic cross-tenant no-oracle matrix', () => {
  ct('H14 org B sees every org-A by-id resource exactly as a random uuid', async () => {
    const a = await manager('iso-a');
    const proj = (
      (
        await call('/projects', {
          method: 'POST',
          cookie: `access_token=${a}`,
          body: JSON.stringify({ name: 'A', type: 'tama38_1' }),
        })
      ).body['data'] as Json
    )['id'] as string;
    const bld = (
      (
        await call(`/projects/${proj}/buildings`, {
          method: 'POST',
          cookie: `access_token=${a}`,
          body: JSON.stringify({ address: 'a', city: 'b' }),
        })
      ).body['data'] as Json
    )['id'] as string;
    const apt = (
      (
        await call(`/buildings/${bld}/apartments`, {
          method: 'POST',
          cookie: `access_token=${a}`,
          body: JSON.stringify({ number: '1' }),
        })
      ).body['data'] as Json
    )['id'] as string;
    const owner = (
      (
        await call('/owners', {
          method: 'POST',
          cookie: `access_token=${a}`,
          body: JSON.stringify({ name: 'o', national_id: validId(seed++) }),
        })
      ).body['data'] as Json
    )['id'] as string;
    const task = (
      (
        await call('/tasks', {
          method: 'POST',
          cookie: `access_token=${a}`,
          body: JSON.stringify({ title: 't' }),
        })
      ).body['data'] as Json
    )['id'] as string;

    const b = await manager('iso-b');
    const random = '00000000-0000-0000-0000-0000000000ff';
    const targets = [
      `/projects/${proj}`,
      `/buildings/${bld}`,
      `/apartments/${apt}`,
      `/owners/${owner}`,
      `/tasks/${task}`,
    ];
    for (const t of targets) {
      const cross = await call(t, { cookie: `access_token=${b}` });
      const ctrl = await call(t.replace(/[^/]+$/, random), { cookie: `access_token=${b}` });
      expect(cross.status, `${t} cross-tenant not 404`).toBe(404);
      expect(cross.status).toBe(ctrl.status);
      expect((cross.body['error'] as Json)?.['code']).toBe((ctrl.body['error'] as Json)?.['code']);
    }
  });
});

describe('HARDENING · concurrency & latency', () => {
  ct('H15 concurrent duplicate owner create → at most ONE success, no 500', async () => {
    const at = await manager('race');
    const nid = validId(seed++);
    const mk = () =>
      call('/owners', {
        method: 'POST',
        cookie: `access_token=${at}`,
        body: JSON.stringify({ name: 'Race', national_id: nid }),
      });
    const results = await Promise.all([mk(), mk(), mk(), mk(), mk()]);
    const ok = results.filter((r) => r.status < 300).length;
    const conflict = results.filter((r) => r.status === 409).length;
    const fatal = results.filter((r) => r.status >= 500).length;
    expect(fatal, 'a concurrent create 500ed').toBe(0);
    expect(ok, `expected ≤1 success, got ${ok}`).toBeLessThanOrEqual(1);
    expect(ok + conflict, 'some racer neither succeeded nor 409').toBe(5);
  });

  ct(
    'H16 hot-path latency guard: create+list project median stays sane',
    async () => {
      const at = await manager('perf');
      const ITER = 8;
      const WARM = 2;
      const samples: number[] = [];
      for (let i = 0; i < WARM + ITER; i++) {
        const t0 = performance.now();
        await call('/projects', {
          method: 'POST',
          cookie: `access_token=${at}`,
          body: JSON.stringify({ name: `P${i}`, type: 'tama38_1' }),
        });
        await call('/projects?limit=25', { cookie: `access_token=${at}` });
        const dt = performance.now() - t0;
        if (i >= WARM) samples.push(dt);
      }
      samples.sort((x, y) => x - y);
      const median = samples[Math.floor(samples.length / 2)] ?? 0;
      const max = samples[samples.length - 1] ?? 0;
      // eslint-disable-next-line no-console
      console.warn(
        `[H16] create+list median=${median.toFixed(0)}ms max=${max.toFixed(0)}ms (n=${ITER})`,
      );
      expect(median, `create+list median ${median.toFixed(0)}ms — pathological`).toBeLessThan(4000);
      expect(max, `create+list max ${max.toFixed(0)}ms — catastrophic`).toBeLessThan(12000);
    },
    120000,
  );
});

describe('HARDENING · idempotency (double-submit / retry safety)', () => {
  ct('H18 same Idempotency-Key replays once; concurrent dup → ≤1 created', async () => {
    const at = await manager('idem');
    const k = crypto.randomUUID();
    const body = JSON.stringify({ name: 'IdemProj', type: 'tama38_1' });
    const post = (key: string | null) =>
      call('/projects', {
        method: 'POST',
        cookie: `access_token=${at}`,
        body,
        headers: key ? { 'Idempotency-Key': key } : {},
      });

    // sequential: 1st creates, 2nd replays the SAME body (same id), no dup
    const r1 = await post(k);
    expect(r1.status, r1.raw).toBeLessThan(300);
    const id1 = (r1.body['data'] as Json)['id'];
    const r2 = await post(k);
    expect(r2.status, 'replay must mirror the original 2xx').toBeLessThan(300);
    expect((r2.body['data'] as Json)['id'], 'replay returned a different row').toBe(id1);

    // a DIFFERENT key with the same payload DOES create a second row
    const r3 = await post(crypto.randomUUID());
    expect((r3.body['data'] as Json)['id']).not.toBe(id1);

    // concurrent storm on one fresh key → at most ONE creation, no 500
    const k2 = crypto.randomUUID();
    const burst = await Promise.all([post(k2), post(k2), post(k2), post(k2), post(k2)]);
    expect(
      burst.every((r) => r.status < 500),
      'a concurrent idem call 500ed',
    ).toBe(true);
    const created = new Set(
      burst.filter((r) => r.status < 300).map((r) => (r.body['data'] as Json)['id'] as string),
    );
    expect(
      created.size,
      `idempotency created ${created.size} distinct rows (want ≤1)`,
    ).toBeLessThanOrEqual(1);

    // malformed key → 400 validation_error (never 500)
    const bad = await post('not-a-uuid');
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('validation_error');
  });
});

describe('HARDENING · pagination integrity (data-loss / dup under keyset)', () => {
  // Creates many rows back-to-back (rapid separate txns → many share the
  // same millisecond, differing only in microseconds), then FULLY walks
  // the keyset cursor at the smallest page size. The set traversed MUST
  // exactly equal the set seen in one big page — no row skipped, none
  // duplicated — and the global order must be strictly monotone. This is
  // the canonical detector for the "cursor precision < column precision"
  // data-loss class.
  ct(
    'H17 full keyset traversal loses/duplicates nothing & stays ordered',
    async () => {
      const at = await manager('pg-int');
      const N = 40;
      for (let i = 0; i < N; i++) {
        const r = await call('/projects', {
          method: 'POST',
          cookie: `access_token=${at}`,
          body: JSON.stringify({ name: `PG${i}`, type: 'tama38_1' }),
        });
        expect(r.status, r.raw).toBeLessThan(300);
      }

      // Ground truth: one large page (limit=100 ≥ N).
      const big = await call('/projects?limit=100', { cookie: `access_token=${at}` });
      const truth = (big.body['data'] as Json[]).map((p) => p['id'] as string);
      expect(truth.length, `expected ${N} in one page`).toBe(N);

      // Walk the cursor at the smallest page size.
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url = cursor
          ? `/projects?limit=3&cursor=${encodeURIComponent(cursor)}`
          : '/projects?limit=3';
        const page = await call(url, { cookie: `access_token=${at}` });
        expect(page.status, `page ${pages} → ${page.raw}`).toBe(200);
        for (const row of page.body['data'] as Json[]) seen.push(row['id'] as string);
        cursor = ((page.body['page'] as Json)['cursor'] as string | null) ?? null;
        pages += 1;
        expect(pages, 'pagination did not terminate (cursor loop)').toBeLessThan(N + 10);
      } while (cursor);

      const seenSet = new Set(seen);
      // No duplicates across pages.
      expect(seenSet.size, `duplicates across pages: ${seen.length} vs ${seenSet.size}`).toBe(
        seen.length,
      );
      // No loss: every truth id was traversed.
      const missing = truth.filter((id) => !seenSet.has(id));
      expect(missing.length, `keyset SKIPPED ${missing.length}/${N} rows (data loss)`).toBe(0);
      // Exact set equality both directions.
      expect(seen.length, `traversed ${seen.length}, truth ${N}`).toBe(N);
      // Same order as the single-page ground truth (stable total order).
      expect(seen).toEqual(truth);
    },
    180000,
  );
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[phase3.hardening] ran against ' + API);
});
