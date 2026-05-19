/**
 * Phase 3 Slice 5 — Ownerships CONTRACT conformance suite (BLACK-BOX).
 *
 * The locked Phase-1 constraint trigger trg_ownerships_sum_check makes an
 * apartment's active shares total 0 or EXACTLY 100 at commit, so the write
 * API is an ATOMIC FULL-SET REPLACE (PUT). Spec: docs/03 §7 T3.OW.1,
 * docs/09 §3.13, D.16, D.17, D.25. Skips if API unreachable; CI
 * `conformance` runs it for real.
 *
 *  OWS1  Unauthenticated → 401.
 *  OWS2  PUT set [60,40] (=100) → 2xx {data:[Ownership]} schema-valid.
 *  OWS3  Bad entry (pct 0 / >100 / unknown field / dup ownerId) → 400
 *        validation_error.
 *  OWS4  Non-empty set whose sum ≠ 100 → 400 (Zod refine → validation_error
 *        for pure-sum; server ownership_sum_invalid as backstop).
 *  OWS5  Replace is atomic: [100] then [60,40] → list shows exactly the 2
 *        new active rows summing 100 (old one ended, not duplicated).
 *  OWS6  Empty owners [] clears all → 2xx, active list empty.
 *  OWS7  Unknown apartment → 404; set referencing unknown ownerId → 404.
 *  OWS8  Cross-tenant apartment → 404 (via-parent isolation).
 *  OWS9  GET /apartments/:id/owners → masked owner + ownershipPct; clear
 *        national_id never in body.
 *  OWS10 GET list {data,page}; tampered cursor → 400 invalid_cursor.
 */
import { OwnershipSchema } from '@emapp/shared-types';
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

async function call(path: string, init?: RequestInit & { cookie?: string }): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-throttle-bypass': BYPASS,
  };
  if (init?.cookie) headers['Cookie'] = init.cookie;
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
function uniqueEmail(tag: string): string {
  return `ows_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`;
}
const PW = 'TestPassword123456';

function validId(seed: number): string {
  const eight = String(seed % 100000000).padStart(8, '0');
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = Number(eight[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return eight + String((10 - (sum % 10)) % 10);
}
let idSeed = 60_000_000 + Math.floor(Math.random() * 30_000_000);
const nextId = (): string => validId(idSeed++);

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'OWS Org',
      name: 'OWS User',
      email: uniqueEmail(tag),
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup did not yield access_token: ${r.raw}`);
  return at;
}

async function newApartment(at: string): Promise<string> {
  const p = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ name: 'OWS P', type: 'tama38_1' }),
  });
  const pid = (p.body['data'] as Json)['id'] as string;
  const b = await call(`/projects/${pid}/buildings`, {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ address: 'S 1', city: 'C' }),
  });
  const bid = (b.body['data'] as Json)['id'] as string;
  const a = await call(`/buildings/${bid}/apartments`, {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ number: 'A1' }),
  });
  return (a.body['data'] as Json)['id'] as string;
}

async function newOwner(at: string): Promise<string> {
  const r = await call('/owners', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ name: 'Owner', national_id: nextId() }),
  });
  return (r.body['data'] as Json)['id'] as string;
}

async function putSet(at: string, apt: string, owners: unknown): Promise<Res> {
  return call(`/apartments/${apt}/ownerships`, {
    method: 'PUT',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ owners }),
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
    console.warn(`[ownerships.contract] API not reachable at ${API} — all tests SKIPPED.`);
  }
});

function ct(name: string, fn: () => Promise<void>) {
  it(
    name,
    async (c) => {
      if (!LIVE) return c.skip();
      await fn();
    },
    40000,
  );
}

describe('CONTRACT · ownerships · set-replace', () => {
  ct('OWS1 unauthenticated → 401', async () => {
    const r = await call('/apartments/00000000-0000-0000-0000-0000000000aa/ownerships');
    expect(r.status).toBe(401);
  });

  ct('OWS2 PUT [60,40]=100 → 2xx {data:[Ownership]} schema-valid', async () => {
    const at = await manager('c');
    const apt = await newApartment(at);
    const o1 = await newOwner(at);
    const o2 = await newOwner(at);
    const r = await putSet(at, apt, [
      { ownerId: o1, ownershipPct: 60, role: 'primary' },
      { ownerId: o2, ownershipPct: 40 },
    ]);
    expect(r.status, r.raw).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    const arr = r.body['data'] as Json[];
    expect(arr.length).toBe(2);
    for (const o of arr) {
      expect(
        OwnershipSchema.safeParse(o).success,
        `not OwnershipSchema: ${JSON.stringify(o)}`,
      ).toBe(true);
    }
  });

  ct('OWS3 invalid entries → 400 validation_error', async () => {
    const at = await manager('inv');
    const apt = await newApartment(at);
    const o1 = await newOwner(at);
    const zero = await putSet(at, apt, [{ ownerId: o1, ownershipPct: 0 }]);
    expect(zero.status).toBe(400);
    const over = await putSet(at, apt, [{ ownerId: o1, ownershipPct: 150 }]);
    expect(over.status).toBe(400);
    const dup = await putSet(at, apt, [
      { ownerId: o1, ownershipPct: 50 },
      { ownerId: o1, ownershipPct: 50 },
    ]);
    expect(dup.status, 'duplicate ownerId not rejected').toBe(400);
    const unknown = await putSet(at, apt, [{ ownerId: o1, ownershipPct: 100, x: 1 }]);
    expect(unknown.status, 'unknown field not rejected (strict)').toBe(400);
    expect((unknown.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('OWS4 non-empty set summing ≠ 100 → 400', async () => {
    const at = await manager('sum');
    const apt = await newApartment(at);
    const o1 = await newOwner(at);
    const o2 = await newOwner(at);
    const half = await putSet(at, apt, [{ ownerId: o1, ownershipPct: 50 }]);
    expect(half.status, 'a 50-only set must be rejected (≠100)').toBe(400);
    const over = await putSet(at, apt, [
      { ownerId: o1, ownershipPct: 70 },
      { ownerId: o2, ownershipPct: 40 },
    ]);
    expect(over.status).toBe(400);
  });

  ct('OWS5 replace is atomic — old set ended, new set active', async () => {
    const at = await manager('rep');
    const apt = await newApartment(at);
    const o1 = await newOwner(at);
    const o2 = await newOwner(at);
    const o3 = await newOwner(at);
    const first = await putSet(at, apt, [{ ownerId: o1, ownershipPct: 100 }]);
    expect(first.status).toBeLessThan(300);
    const second = await putSet(at, apt, [
      { ownerId: o2, ownershipPct: 60 },
      { ownerId: o3, ownershipPct: 40 },
    ]);
    expect(second.status).toBeLessThan(300);
    const list = await call(`/apartments/${apt}/ownerships`, { cookie: `access_token=${at}` });
    const ids = (list.body['data'] as Json[]).map((x) => x['ownerId']);
    expect(ids.length).toBe(2);
    expect(ids).toContain(o2);
    expect(ids).toContain(o3);
    expect(ids).not.toContain(o1);
    const sum = (list.body['data'] as Json[]).reduce((a, x) => a + Number(x['ownershipPct']), 0);
    expect(sum).toBe(100);
  });

  ct('OWS6 empty owners [] clears all → 2xx, active list empty', async () => {
    const at = await manager('clr');
    const apt = await newApartment(at);
    const o1 = await newOwner(at);
    await putSet(at, apt, [{ ownerId: o1, ownershipPct: 100 }]);
    const cleared = await putSet(at, apt, []);
    expect(cleared.status, cleared.raw).toBeLessThan(300);
    const list = await call(`/apartments/${apt}/ownerships`, { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).length).toBe(0);
  });

  ct('OWS7 unknown apartment → 404; unknown ownerId → 404', async () => {
    const at = await manager('nf');
    const bad = await putSet(at, '00000000-0000-0000-0000-0000000000bb', [
      { ownerId: await newOwner(at), ownershipPct: 100 },
    ]);
    expect(bad.status).toBe(404);
    const apt = await newApartment(at);
    const r2 = await putSet(at, apt, [
      { ownerId: '00000000-0000-0000-0000-0000000000cc', ownershipPct: 100 },
    ]);
    expect(r2.status).toBe(404);
  });

  ct('OWS8 cross-tenant apartment → 404 (via-parent isolation)', async () => {
    const atA = await manager('iso-a');
    const aptA = await newApartment(atA);
    const atB = await manager('iso-b');
    const cross = await putSet(atB, aptA, [{ ownerId: await newOwner(atB), ownershipPct: 100 }]);
    expect(cross.status, 'org B wrote into org A apartment').toBe(404);
  });

  ct('OWS9 GET /apartments/:id/owners → masked owner + share; no clear PII', async () => {
    const at = await manager('view');
    const apt = await newApartment(at);
    const nid = nextId();
    const oc = await call('/owners', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'Viewed', national_id: nid }),
    });
    const ownerId = (oc.body['data'] as Json)['id'] as string;
    await putSet(at, apt, [{ ownerId, ownershipPct: 100 }]);
    const r = await call(`/apartments/${apt}/owners`, { cookie: `access_token=${at}` });
    expect(r.status).toBe(200);
    const row = (r.body['data'] as Json[])[0] as Json;
    expect(row['ownershipPct']).toBe(100);
    expect(String(row['nationalIdMasked'])).toContain(nid.slice(-2));
    expect(r.raw.includes(nid), 'clear national_id leaked in apartment-owners view').toBe(false);
  });

  ct('OWS10 list {data,page}; tampered cursor → 400 invalid_cursor', async () => {
    const at = await manager('cur');
    const apt = await newApartment(at);
    const ok = await call(`/apartments/${apt}/ownerships`, { cookie: `access_token=${at}` });
    expect(ok.status).toBe(200);
    expect(ok.body['page']).toHaveProperty('has_more');
    const bad = await call(`/apartments/${apt}/ownerships?cursor=nope`, {
      cookie: `access_token=${at}`,
    });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[ownerships.contract] ran against ' + API);
});
