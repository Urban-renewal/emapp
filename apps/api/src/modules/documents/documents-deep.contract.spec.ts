/**
 * Phase 4 — Documents DEEP black-box suite (user-directed audit, 2026-05-20).
 *
 * Treats the API like a stranger. Closes coverage gaps left by
 * documents.contract.spec (DOC1–12) + storage.spec (factory/key/filename)
 * + redteam K1–K6. Anchored to docs/07's 5 core principles:
 *   (01 SOLID) (02 Security-first) (03 Performance) (04 Min runtime)
 *   (05 DRY/efficiency).
 *
 * Angles covered (deeper than the contract suite):
 *   DD1  Error-code catalog completeness — every documented code fires.
 *   DD2  Mass-assignment / parameter tampering blocked by `.strict()`.
 *   DD3  Lifecycle — archive idempotency (2nd DELETE → 204, no extra audit).
 *   DD4  Lifecycle — finalize idempotent on matching declared values.
 *   DD5  Lifecycle — finalize after archive → 404 (no integrity_reject loop).
 *   DD6  Audit trail — create row visible; NO r2Key / NO URL in audit body.
 *   DD7  Audit trail — every download is recorded (ISO A.12.4 evidence).
 *   DD8  Idempotency-Key replay → same document id (no duplicate row).
 *   DD9  Deep no-leak — error bodies are pure {error:{code}}, nothing more.
 *   DD10 Runtime latency guard — create+download median stays sane.
 */
import { randomUUID } from 'node:crypto';

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
  init: RequestInit & { cookie?: string; idemKey?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-throttle-bypass': BYPASS,
  };
  if (init.cookie) headers['Cookie'] = init.cookie;
  if (init.idemKey) headers['Idempotency-Key'] = init.idemKey;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
  });
  const raw = await res.text();
  let body: Json = {};
  try {
    body = raw ? (JSON.parse(raw) as Json) : {};
  } catch {
    body = { __nonjson: raw };
  }
  const gsc = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof gsc === 'function' ? gsc.call(res.headers) : [];
  return { status: res.status, body, raw, cookies };
}

function cookieOf(set: string[], name: string): string | undefined {
  return set
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.split('=')[1];
}
const uniqEmail = (t: string): string =>
  `dd_${t}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`;
const PW = 'TestPassword123456';

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'DD Org',
      name: 'DD User',
      email: uniqEmail(tag),
      password: PW,
    }),
  });
  const at = cookieOf(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  return at;
}

const validDoc = (over: Json = {}): Json => ({
  name: 'audit.pdf',
  type: 'contract',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  contentHash: 'sha256:deadbeef',
  ...over,
});
async function createDoc(at: string, body: Json, idemKey?: string): Promise<Res> {
  return call('/documents', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify(body),
    ...(idemKey ? { idemKey } : {}),
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
    console.warn(`[documents-deep] API not reachable — all tests SKIPPED.`);
  }
});

function ct(name: string, fn: () => Promise<void>, timeoutMs = 30_000) {
  it(
    name,
    async (c) => {
      if (!LIVE) return c.skip();
      await fn();
    },
    timeoutMs,
  );
}

const KEY_RE = /org\/[0-9a-f-]+\/doc\/[0-9a-f-]+/i;
const ALLOWED_KEYS = new Set(['code', 'message', 'details']);

// "deep no-leak": an error body is exactly { error: { code: ..., (message?, details?) } } —
// nothing else (no stack, no pgcode, no internal field names, no PII).
function assertCleanError(r: Res, expectedCode: string, ctx: string): void {
  expect(r.body['data'], `${ctx}: error body has 'data'`).toBeUndefined();
  const err = r.body['error'] as Json | undefined;
  expect(err, `${ctx}: error body missing 'error'`).toBeDefined();
  expect(err?.['code'], `${ctx}: wrong code (got ${String(err?.['code'])})`).toBe(expectedCode);
  for (const k of Object.keys(err ?? {})) {
    expect(ALLOWED_KEYS.has(k), `${ctx}: unexpected error key '${k}'`).toBe(true);
  }
}

// ── DD1 — error-code catalog completeness ──────────────────────────────────
describe('DOCUMENTS · DEEP · error catalog (every code fires)', () => {
  ct('DD1.a unauthenticated → 401 missing_token (envelope clean)', async () => {
    const r = await call('/documents');
    expect(r.status).toBe(401);
    assertCleanError(r, 'missing_token', 'no cookie');
  });

  ct('DD1.b validation_error on bad body / unknown / oversize / bad mime', async () => {
    const at = await manager('e1');
    for (const body of [
      validDoc({ name: '' }),
      validDoc({ sizeBytes: 0 }),
      validDoc({ sizeBytes: 999_999_999 }),
      validDoc({ mimeType: 'application/x-msdownload' }),
      validDoc({ type: 'made_up_type' }),
      validDoc({ extra_field: 1 }),
    ]) {
      const r = await createDoc(at, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      assertCleanError(r, 'validation_error', JSON.stringify(body));
    }
  });

  ct('DD1.c not_found on random id (GET / download / finalize / patch)', async () => {
    const at = await manager('e2');
    const id = '00000000-0000-0000-0000-0000000000ee';
    const cookie = `access_token=${at}`;
    const g = await call(`/documents/${id}`, { cookie });
    expect(g.status).toBe(404);
    assertCleanError(g, 'not_found', 'GET');
    const d = await call(`/documents/${id}/download`, { cookie });
    expect(d.status).toBe(404);
    assertCleanError(d, 'not_found', 'download');
    const f = await call(`/documents/${id}/finalize`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ sizeBytes: 1, contentHash: 'x' }),
    });
    expect(f.status).toBe(404);
    assertCleanError(f, 'not_found', 'finalize');
    const p = await call(`/documents/${id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ name: 'x' }),
    });
    expect(p.status).toBe(404);
    assertCleanError(p, 'not_found', 'patch');
  });

  ct('DD1.d invalid_cursor on tampered cursor', async () => {
    const at = await manager('e3');
    const r = await call('/documents?cursor=not-a-real-cursor', {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(400);
    assertCleanError(r, 'invalid_cursor', 'cursor');
  });

  ct('DD1.e bad_request / invalid_json on malformed JSON', async () => {
    const at = await manager('e4');
    const r = await call('/documents', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: '{ not json',
    });
    expect(r.status).toBe(400);
    expect(['invalid_json', 'bad_request']).toContain(
      (r.body['error'] as Json | undefined)?.['code'],
    );
  });
});

// ── DD2 — mass-assignment / strict reject ──────────────────────────────────
describe('DOCUMENTS · DEEP · mass-assignment blocked', () => {
  ct('DD2 strict rejects organizationId / uploadedBy / id / r2Key / archivedAt', async () => {
    const at = await manager('m');
    for (const inj of [
      { organizationId: '00000000-0000-0000-0000-000000000000' },
      { uploadedBy: '00000000-0000-0000-0000-000000000000' },
      { id: '11111111-1111-1111-1111-111111111111' },
      { r2Key: 'attacker-controlled/key' },
      { r2_key: 'attacker-controlled/key' },
      { archivedAt: '2020-01-01' },
      { createdAt: '2020-01-01' },
    ]) {
      const r = await createDoc(at, validDoc(inj));
      expect(r.status, JSON.stringify(inj)).toBe(400);
      assertCleanError(r, 'validation_error', JSON.stringify(inj));
    }
  });
});

// ── DD3/DD4/DD5 — lifecycle correctness ────────────────────────────────────
describe('DOCUMENTS · DEEP · lifecycle invariants', () => {
  ct('DD3 archive is idempotent (2nd DELETE → 204, list still excludes)', async () => {
    const at = await manager('lc1');
    const c = await createDoc(at, validDoc());
    const id = ((c.body['data'] as Json)['document'] as Json)['id'] as string;
    const d1 = await call(`/documents/${id}`, { method: 'DELETE', cookie: `access_token=${at}` });
    const d2 = await call(`/documents/${id}`, { method: 'DELETE', cookie: `access_token=${at}` });
    expect(d1.status).toBe(204);
    expect(d2.status).toBe(204); // idempotent (early-return on already-archived)
    const list = await call('/documents', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((x) => x['id'] === id)).toBe(false);
  });

  ct('DD4 finalize is idempotent on matching declared values', async () => {
    const at = await manager('lc2');
    const c = await createDoc(at, validDoc({ sizeBytes: 4096, contentHash: 'h-match' }));
    const id = ((c.body['data'] as Json)['document'] as Json)['id'] as string;
    const url = `/documents/${id}/finalize`;
    const body = JSON.stringify({ sizeBytes: 4096, contentHash: 'h-match' });
    const f1 = await call(url, { method: 'POST', cookie: `access_token=${at}`, body });
    const f2 = await call(url, { method: 'POST', cookie: `access_token=${at}`, body });
    expect(f1.status, f1.raw).toBe(200);
    expect(f2.status, f2.raw).toBe(200); // re-finalize with same values is safe
  });

  ct('DD5 finalize after archive → 404 (no integrity loop)', async () => {
    const at = await manager('lc3');
    const c = await createDoc(at, validDoc());
    const id = ((c.body['data'] as Json)['document'] as Json)['id'] as string;
    await call(`/documents/${id}`, { method: 'DELETE', cookie: `access_token=${at}` });
    const f = await call(`/documents/${id}/finalize`, {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ sizeBytes: 1024, contentHash: 'sha256:deadbeef' }),
    });
    expect(f.status).toBe(404);
    assertCleanError(f, 'not_found', 'finalize-after-archive');
  });
});

// ── DD6/DD7 — audit trail (ISO A.12.4) ─────────────────────────────────────
describe('DOCUMENTS · DEEP · audit trail (ISO A.12.4)', () => {
  ct('DD6 create writes a clean audit row (no r2Key / no URL in audit)', async () => {
    const at = await manager('au1');
    const c = await createDoc(at, validDoc({ name: 'audited.pdf' }));
    const id = ((c.body['data'] as Json)['document'] as Json)['id'] as string;
    const audit = await call('/audit?limit=50', { cookie: `access_token=${at}` });
    expect(audit.status).toBe(200);
    const rows = audit.body['data'] as Json[];
    const row = rows.find((r) => r['action'] === 'document.create' && r['targetId'] === id);
    expect(row, 'document.create audit row missing').toBeDefined();
    expect(KEY_RE.test(audit.raw), 'r2Key leaked in audit body').toBe(false);
    expect(
      audit.raw.includes('http://') || audit.raw.includes('https://'),
      'URL in audit body',
    ).toBe(false);
  });

  ct('DD7 download writes a document.download audit row (every access tracked)', async () => {
    const at = await manager('au2');
    const c = await createDoc(at, validDoc());
    const id = ((c.body['data'] as Json)['document'] as Json)['id'] as string;
    await call(`/documents/${id}/download`, { cookie: `access_token=${at}` });
    await call(`/documents/${id}/download`, { cookie: `access_token=${at}` });
    const audit = await call('/audit?limit=100', { cookie: `access_token=${at}` });
    const downloads = (audit.body['data'] as Json[]).filter(
      (r) => r['action'] === 'document.download' && r['targetId'] === id,
    );
    expect(downloads.length, 'every download must be audited').toBeGreaterThanOrEqual(2);
  });
});

// ── DD8 — Idempotency-Key replay (Stripe-style) ────────────────────────────
describe('DOCUMENTS · DEEP · idempotency', () => {
  ct('DD8 same Idempotency-Key → same document id (no duplicate row)', async () => {
    const at = await manager('idem');
    const k = randomUUID();
    const r1 = await createDoc(at, validDoc({ name: 'idem.pdf' }), k);
    const r2 = await createDoc(at, validDoc({ name: 'idem.pdf' }), k);
    const id1 = ((r1.body['data'] as Json | undefined)?.['document'] as Json | undefined)?.['id'];
    const id2 = ((r2.body['data'] as Json | undefined)?.['document'] as Json | undefined)?.['id'];
    expect(id1, r1.raw).toBeTruthy();
    expect(id2, r2.raw).toBeTruthy();
    expect(id1).toBe(id2);
  });
});

// ── DD9 — deep no-leak across every documented error path ──────────────────
describe('DOCUMENTS · DEEP · zero-leak error envelopes', () => {
  ct('DD9 every error path returns ONLY {error:{code,(message?,details?)}}', async () => {
    const at = await manager('nl');
    const calls: Array<[() => Promise<Res>, string]> = [
      [() => call('/documents'), 'no-auth'],
      [
        () =>
          call('/documents', {
            method: 'POST',
            cookie: `access_token=${at}`,
            body: JSON.stringify(validDoc({ mimeType: 'image/svg+xml' })),
          }),
        'bad-mime',
      ],
      [
        () =>
          call('/documents/00000000-0000-0000-0000-00000000aaaa', { cookie: `access_token=${at}` }),
        '404',
      ],
      [() => call('/documents?cursor=nope', { cookie: `access_token=${at}` }), 'bad-cursor'],
    ];
    for (const [fn, ctx] of calls) {
      const r = await fn();
      expect(r.status, ctx).toBeGreaterThanOrEqual(400);
      const err = r.body['error'] as Json | undefined;
      expect(err, `${ctx}: missing error`).toBeDefined();
      for (const k of Object.keys(err ?? {})) {
        expect(ALLOWED_KEYS.has(k), `${ctx}: leaks key '${k}'`).toBe(true);
      }
    }
  });
});

// ── DD11/DD12 — FE-readiness preflight + CSP (audit-pass A1/A2 fixes) ─────
describe('DOCUMENTS · DEEP · browser-FE readiness (CORS preflight + CSP)', () => {
  ct('DD11 CORS preflight ALLOWS Idempotency-Key (was silently blocked)', async () => {
    const res = await fetch(`${API}/documents`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3001',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'idempotency-key, content-type',
      },
    });
    expect(res.status).toBeLessThan(300);
    const allow = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allow, 'CORS allow-headers must include idempotency-key').toContain('idempotency-key');
    // Sanity — auth + content-type still allowed too.
    expect(allow).toContain('authorization');
    expect(allow).toContain('content-type');
  });

  ct('DD12 CSP connect-src ALLOWS R2 (was: would block FE→R2 presigned PUT/GET)', async () => {
    const res = await fetch(`${API}/health`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp, 'CSP header missing').toBeTruthy();
    // Pull the connect-src directive.
    const connectMatch = csp.match(/connect-src ([^;]+)/i);
    expect(connectMatch, 'connect-src directive missing').toBeTruthy();
    const connectSrc = (connectMatch?.[1] ?? '').toLowerCase();
    expect(connectSrc).toContain('r2.cloudflarestorage.com');
    // Sanity — 'self' + sentry + resend still allowed.
    expect(connectSrc).toContain("'self'");
  });
});

// ── DD10 — runtime latency guard (Principle 03/04: performance/min-runtime) ─
describe('DOCUMENTS · DEEP · runtime latency budget', () => {
  ct(
    'DD10 create+download median stays under the budget (5 samples)',
    async () => {
      const at = await manager('rt');
      const c = await createDoc(at, validDoc({ name: 'lat.pdf' }));
      const id = ((c.body['data'] as Json)['document'] as Json)['id'] as string;
      const ms: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        const r = await call(`/documents/${id}/download`, { cookie: `access_token=${at}` });
        ms.push(Date.now() - t0);
        expect(r.status).toBe(200);
      }
      ms.sort((a, b) => a - b);
      const median = ms[Math.floor(ms.length / 2)] ?? Number.POSITIVE_INFINITY;
      // eslint-disable-next-line no-console
      console.warn(`[DD10] download latencies(ms)=${ms.join(',')} median=${median}`);
      // CI-stable budget (Fake provider — DB roundtrip + audit insert + presign).
      // R2 will be slower; recalibrate at the swap. Keep budget generous to
      // avoid flake on shared CI runners, but tight enough to catch regressions.
      expect(median, `download median over budget: ${median}ms`).toBeLessThan(2500);
    },
    60_000,
  );
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[documents-deep] ran against ' + API);
});
