/**
 * Phase 3 Slice 4 — Owners CONTRACT conformance suite (BLACK-BOX).
 *
 * Spec-derived (docs/03 §7 T3.O.1, docs/09 §3.13 Owner, D.16, D.17,
 * D.19 national_id, Doc07 PII rules, CLAUDE.md, DECISIONS-V12 D.54). PII
 * invariant (D.54): the `nationalIdMasked`/`phoneMasked` fields are ALWAYS
 * masked (the §v9-M-4 tripwire). Cleartext is returned ONLY in the dedicated
 * `nationalId`/`phone` fields and ONLY to an `unmasked` actor — a manager, or an
 * agent with `view_owner_pii` (D.54 supersedes D.19/D.46 "org-staff always
 * masked"). These contract checks run as a manager (= unmasked); masked-fidelity
 * actors are pinned by the deterministic `owners-fidelity.spec`. Skips if API
 * unreachable; CI `conformance` runs it for real.
 *
 *  OWN1  Unauthenticated → 401.
 *  OWN2  Manager create (valid 9-digit+checksum id) → 2xx {data:{Owner}};
 *        OwnerSchema-shaped; nationalIdMasked = "•••••••"+last2; the CLEAR
 *        national_id / phone NEVER appear anywhere in the response body.
 *  OWN3  Bad checksum / non-9-digit / unknown field → 400 validation_error.
 *  OWN4  Duplicate national_id in same org → 409 owner_exists.
 *  OWN5  List → masked rows, {data,page}; clear PII never in body.
 *  OWN6  GET /owners/:id (own) → 200 masked.
 *  OWN7  GET random uuid → 404 not_found.
 *  OWN8  Cross-tenant GET → 404 (org RLS isolation, no oracle).
 *  OWN9  POST /owners/search by national_id → returns the owner (HMAC
 *        round-trip, T3.O.1), masked; wrong id → empty.
 *  OWN10 Search by phone (normalized) round-trips.
 *  OWN11 PATCH name persists; GET random→404 etc.
 *  OWN12 DELETE → 204; gone from list (soft archive).
 *  OWN13 Tampered cursor → 400 invalid_cursor.
 */
import { OwnerSchema } from '@emapp/shared-types';
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
  return `own_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`;
}
const PW = 'TestPassword123456';

// Build a structurally + checksum valid 9-digit Israeli ID from a seed.
// Weights 1,2,1,2,1,2,1,2 for the first 8 digits (double→subtract 9),
// then the 9th digit (weight 1) is chosen so the total ≡ 0 (mod 10).
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
  const check = (10 - (sum % 10)) % 10;
  return eight + String(check);
}
let idSeed = 10_000_000 + Math.floor(Math.random() * 50_000_000);
const nextId = (): string => validId(idSeed++);

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'OWN Org',
      name: 'OWN User',
      email: uniqueEmail(tag),
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup did not yield access_token: ${r.raw}`);
  return at;
}

async function createOwner(at: string, body: Json): Promise<Res> {
  return call('/owners', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify(body),
  });
}

// D.54 — for an `unmasked` actor (these contract checks run as a manager) the
// cleartext national_id lives ONLY in the dedicated `nationalId` field, while
// `nationalIdMasked` STAYS masked (never overloaded — the §v9-M-4 tripwire). The
// pre-D.54 "no clear PII anywhere, for anyone" rule is superseded for unmasked
// actors (DECISIONS-V12 D.54 supersedes D.19/D.46 "org-staff always masked");
// masked-fidelity actors are pinned by the deterministic owners-fidelity.spec.
function assertUnmaskedOwner(o: Json, nationalId: string): void {
  expect(String(o['nationalIdMasked']), 'masked field must stay masked').toMatch(/^•+\d{2}$/);
  expect(
    String(o['nationalIdMasked']),
    'full id must not appear in the masked field',
  ).not.toContain(nationalId);
  expect(o['nationalId'], 'unmasked actor should receive cleartext national_id').toBe(nationalId);
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
    console.warn(`[owners.contract] API not reachable at ${API} — all tests SKIPPED.`);
  }
});

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

describe('CONTRACT · owners · auth', () => {
  ct('OWN1 unauthenticated list → 401', async () => {
    const r = await call('/owners');
    expect(r.status).toBe(401);
  });
});

describe('CONTRACT · owners · CRUD + PII masking', () => {
  ct(
    'OWN2 create → masked field stays masked; manager (unmasked) gets cleartext field',
    async () => {
      const at = await manager('c');
      const nid = nextId();
      const r = await createOwner(at, {
        name: 'דנה כהן',
        national_id: nid,
        phone: '0501234567',
        email: 'dana@example.com',
      });
      expect(r.status, r.raw).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(300);
      const data = r.body['data'] as Json;
      expect(OwnerSchema.safeParse(data).success, `not OwnerSchema: ${r.raw}`).toBe(true);
      expect(String(data['nationalIdMasked'])).toContain(nid.slice(-2));
      expect(data['phoneMasked']).not.toBeNull();
      assertUnmaskedOwner(data, nid); // manager = unmasked (D.54)
    },
  );

  ct('OWN3 bad checksum / shape / unknown field → 400 validation_error', async () => {
    const at = await manager('inv');
    const badChecksum = await createOwner(at, { name: 'x', national_id: '123456789' });
    expect(badChecksum.status, 'bad-checksum id accepted').toBe(400);
    expect((badChecksum.body['error'] as Json)?.['code']).toBe('validation_error');
    const shortId = await createOwner(at, { name: 'x', national_id: '12345' });
    expect(shortId.status).toBe(400);
    const unknown = await createOwner(at, { name: 'x', national_id: nextId(), injected: true });
    expect(unknown.status, 'unknown field not rejected (strict)').toBe(400);
  });

  ct('OWN4 duplicate national_id in same org → 409 owner_exists', async () => {
    const at = await manager('dup');
    const nid = nextId();
    const first = await createOwner(at, { name: 'A', national_id: nid });
    expect(first.status).toBeLessThan(300);
    const dup = await createOwner(at, { name: 'B', national_id: nid });
    expect(dup.status).toBe(409);
    expect((dup.body['error'] as Json)?.['code']).toBe('owner_exists');
  });

  ct('OWN5/OWN6 list + get: masked field stays masked, manager gets cleartext field', async () => {
    const at = await manager('rd');
    const nid = nextId();
    const created = await createOwner(at, {
      name: 'List Me',
      national_id: nid,
      phone: '0529876543',
    });
    const id = (created.body['data'] as Json)['id'] as string;

    const list = await call('/owners', { cookie: `access_token=${at}` });
    expect(list.status).toBe(200);
    expect(list.body['page']).toHaveProperty('has_more');
    const listed = (list.body['data'] as Json[]).find((o) => o['id'] === id);
    expect(listed, 'created owner not in list').toBeTruthy();
    assertUnmaskedOwner(listed as Json, nid);

    const one = await call(`/owners/${id}`, { cookie: `access_token=${at}` });
    expect(one.status).toBe(200);
    assertUnmaskedOwner(one.body['data'] as Json, nid);
  });

  ct('OWN7 random uuid → 404 not_found', async () => {
    const at = await manager('nf');
    const r = await call('/owners/00000000-0000-0000-0000-0000000000dd', {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(404);
    expect((r.body['error'] as Json)?.['code']).toBe('not_found');
  });

  ct('OWN8 cross-tenant get → 404 (org RLS isolation)', async () => {
    const atA = await manager('iso-a');
    const created = await createOwner(atA, { name: 'Secret', national_id: nextId() });
    const idA = (created.body['data'] as Json)['id'] as string;
    const atB = await manager('iso-b');
    const cross = await call(`/owners/${idA}`, { cookie: `access_token=${atB}` });
    expect(cross.status, 'org B saw org A owner').toBe(404);
  });
});

describe('CONTRACT · owners · HMAC search (T3.O.1)', () => {
  ct('OWN9 search by national_id round-trips (masked); wrong → empty', async () => {
    const at = await manager('s1');
    const nid = nextId();
    const created = await createOwner(at, { name: 'Searchable', national_id: nid });
    const id = (created.body['data'] as Json)['id'] as string;

    const found = await call('/owners/search', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ national_id: nid }),
    });
    expect(found.status).toBe(200);
    const arr = found.body['data'] as Json[];
    const hit = arr.find((o) => o['id'] === id);
    expect(hit, 'HMAC search did not find the owner').toBeTruthy();
    assertUnmaskedOwner(hit as Json, nid); // manager = unmasked (D.54)

    const miss = await call('/owners/search', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ national_id: nextId() }),
    });
    expect(miss.status).toBe(200);
    expect((miss.body['data'] as Json[]).length).toBe(0);
  });

  ct('OWN10 search by phone (normalized) round-trips', async () => {
    const at = await manager('s2');
    const nid = nextId();
    await createOwner(at, { name: 'Phoned', national_id: nid, phone: '0541112233' });
    const found = await call('/owners/search', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ phone: '054-111-2233' }),
    });
    expect(found.status).toBe(200);
    expect((found.body['data'] as Json[]).length).toBeGreaterThanOrEqual(1);
  });

  ct('OWN3b search with neither field → 400 validation_error', async () => {
    const at = await manager('s3');
    const r = await call('/owners/search', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });
});

describe('CONTRACT · owners · update / archive / pagination', () => {
  ct('OWN11 patch name persists', async () => {
    const at = await manager('upd');
    const created = await createOwner(at, { name: 'Old Name', national_id: nextId() });
    const id = (created.body['data'] as Json)['id'] as string;
    const patched = await call(`/owners/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'New Name' }),
    });
    expect(patched.status).toBe(200);
    expect((patched.body['data'] as Json)['name']).toBe('New Name');
  });

  ct('OWN12 delete is a soft archive — gone from list', async () => {
    const at = await manager('del');
    const created = await createOwner(at, { name: 'Doomed', national_id: nextId() });
    const id = (created.body['data'] as Json)['id'] as string;
    const del = await call(`/owners/${id}`, { method: 'DELETE', cookie: `access_token=${at}` });
    expect(del.status).toBe(204);
    const list = await call('/owners', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((o) => o['id'] === id)).toBe(false);
  });

  ct('OWN13 tampered cursor → 400 invalid_cursor', async () => {
    const at = await manager('badcur');
    const r = await call('/owners?cursor=nope', { cookie: `access_token=${at}` });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[owners.contract] ran against ' + API);
});
