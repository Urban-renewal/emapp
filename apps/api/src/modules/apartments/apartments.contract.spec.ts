/**
 * Phase 3 Slice 3 — Apartments CONTRACT conformance suite (BLACK-BOX).
 *
 * Spec-derived (docs/03 §7 incl. T3.A.1, docs/09 §3.13, D.16, D.17,
 * CLAUDE.md: entity "apartment" never "unit", soft-delete=archivedAt,
 * via-parent isolation). Skips if API unreachable; CI `conformance`
 * runs it for real.
 *
 *  AR1  Unauthenticated → 401.
 *  AR2  Manager create under own building → 2xx {data:{Apartment}}
 *       (ApartmentSchema-shaped; buildingId from URL; default status pending).
 *  AR3  Invalid / unknown-field body → 400 validation_error (strict).
 *  AR4  Create under unknown/foreign building → 404 (no oracle).
 *  AR5  List shows it; GET /apartments/:id returns it.
 *  AR6  GET random uuid → 404 not_found.
 *  AR7  Cross-tenant GET of another org's apartment → 404.
 *  AR8  PATCH persists; statusChangedAt advances ONLY on a real status
 *       change (idempotent same-status PATCH must not move it).
 *  AR9  DELETE → 204; gone from the building list (soft archive, T3.A.1).
 *  AR10 Keyset pagination: limit=1 over ≥2 → has_more + working cursor.
 *  AR11 Tampered cursor → 400 invalid_cursor.
 */
import { ApartmentSchema } from '@emapp/shared-types';
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
  return `ar_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`;
}
const PW = 'TestPassword123456';

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'AR Org',
      name: 'AR User',
      email: uniqueEmail(tag),
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup did not yield access_token: ${r.raw}`);
  return at;
}

async function newBuilding(at: string): Promise<string> {
  const p = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ name: 'Host P', type: 'tama38_1' }),
  });
  const pid = (p.body['data'] as Json)['id'] as string;
  const b = await call(`/projects/${pid}/buildings`, {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ address: 'Host St 1', city: 'TLV' }),
  });
  return (b.body['data'] as Json)['id'] as string;
}

async function createApartment(at: string, buildingId: string, body: Json): Promise<Res> {
  return call(`/buildings/${buildingId}/apartments`, {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify(body),
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
    console.warn(`[apartments.contract] API not reachable at ${API} — all tests SKIPPED.`);
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

describe('CONTRACT · apartments · auth', () => {
  ct('AR1 unauthenticated list → 401', async () => {
    const r = await call('/buildings/00000000-0000-0000-0000-0000000000aa/apartments');
    expect(r.status).toBe(401);
  });
});

describe('CONTRACT · apartments · CRUD', () => {
  ct('AR2 manager create → 2xx {data:{Apartment}} schema-valid, default pending', async () => {
    const at = await manager('c');
    const bid = await newBuilding(at);
    const r = await createApartment(at, bid, { number: '12', floor: 3, rooms: 4, sizeSqm: 88.5 });
    expect(r.status, r.raw).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    const data = r.body['data'];
    expect(ApartmentSchema.safeParse(data).success, `not ApartmentSchema: ${r.raw}`).toBe(true);
    expect((data as Json)['buildingId']).toBe(bid);
    expect((data as Json)['status']).toBe('pending');
  });

  ct('AR3 invalid / unknown field → 400 validation_error', async () => {
    const at = await manager('inv');
    const bid = await newBuilding(at);
    const missing = await createApartment(at, bid, { floor: 1 }); // no number
    expect(missing.status).toBe(400);
    const badStatus = await createApartment(at, bid, { number: '1', status: 'sold' });
    expect(badStatus.status).toBe(400);
    const unknown = await createApartment(at, bid, { number: '1', injected: true });
    expect(unknown.status, 'unknown field not rejected (strict)').toBe(400);
    expect((unknown.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('AR4 create under unknown/foreign building → 404 (no oracle)', async () => {
    const at = await manager('fb');
    const unknown = await createApartment(at, '00000000-0000-0000-0000-0000000000bb', {
      number: '1',
    });
    expect(unknown.status).toBe(404);
    const atB = await manager('fb-b');
    const bidB = await newBuilding(atB);
    const cross = await createApartment(at, bidB, { number: '1' });
    expect(cross.status, 'created apartment under another org building').toBe(404);
  });

  ct('AR5 list shows it; get by id returns it', async () => {
    const at = await manager('rd');
    const bid = await newBuilding(at);
    const created = await createApartment(at, bid, { number: '7' });
    const id = (created.body['data'] as Json)['id'] as string;

    const list = await call(`/buildings/${bid}/apartments`, { cookie: `access_token=${at}` });
    expect(list.status).toBe(200);
    expect((list.body['data'] as Json[]).some((a) => a['id'] === id)).toBe(true);

    const one = await call(`/apartments/${id}`, { cookie: `access_token=${at}` });
    expect(one.status).toBe(200);
    expect((one.body['data'] as Json)['id']).toBe(id);
  });

  ct('AR6 random uuid → 404 not_found', async () => {
    const at = await manager('nf');
    const r = await call('/apartments/00000000-0000-0000-0000-0000000000cc', {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(404);
    expect((r.body['error'] as Json)?.['code']).toBe('not_found');
  });

  ct('AR7 cross-tenant get → 404 (via-parent isolation)', async () => {
    const atA = await manager('iso-a');
    const bidA = await newBuilding(atA);
    const created = await createApartment(atA, bidA, { number: 'secret' });
    const idA = (created.body['data'] as Json)['id'] as string;
    const atB = await manager('iso-b');
    const cross = await call(`/apartments/${idA}`, { cookie: `access_token=${atB}` });
    expect(cross.status, 'org B saw org A apartment').toBe(404);
  });

  ct('AR8 patch persists; statusChangedAt moves only on a real status change', async () => {
    const at = await manager('upd');
    const bid = await newBuilding(at);
    const created = await createApartment(at, bid, { number: '1', status: 'pending' });
    const id = (created.body['data'] as Json)['id'] as string;
    const t0 = (created.body['data'] as Json)['statusChangedAt'] as string;

    // same status → statusChangedAt unchanged
    const same = await call(`/apartments/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ status: 'pending', notes: 'touch' }),
    });
    expect(same.status).toBe(200);
    expect((same.body['data'] as Json)['statusChangedAt']).toBe(t0);

    // real transition → statusChangedAt advances
    const moved = await call(`/apartments/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ status: 'contacted' }),
    });
    expect(moved.status).toBe(200);
    expect((moved.body['data'] as Json)['status']).toBe('contacted');
    expect(
      new Date((moved.body['data'] as Json)['statusChangedAt'] as string).getTime(),
    ).toBeGreaterThan(new Date(t0).getTime());
  });

  ct('AR9 delete is a soft archive — gone from list (T3.A.1)', async () => {
    const at = await manager('del');
    const bid = await newBuilding(at);
    const created = await createApartment(at, bid, { number: 'doomed' });
    const id = (created.body['data'] as Json)['id'] as string;
    const del = await call(`/apartments/${id}`, { method: 'DELETE', cookie: `access_token=${at}` });
    expect(del.status).toBe(204);
    const list = await call(`/buildings/${bid}/apartments`, { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((a) => a['id'] === id)).toBe(false);
  });
});

describe('CONTRACT · apartments · pagination', () => {
  ct('AR10 limit=1 over ≥2 → has_more + working cursor, no dup', async () => {
    const at = await manager('pg');
    const bid = await newBuilding(at);
    await createApartment(at, bid, { number: 'A1' });
    await createApartment(at, bid, { number: 'A2' });
    const p1 = await call(`/buildings/${bid}/apartments?limit=1`, { cookie: `access_token=${at}` });
    const page1 = p1.body['page'] as Json;
    expect((p1.body['data'] as Json[]).length).toBe(1);
    expect(page1['has_more']).toBe(true);
    const firstId = (p1.body['data'] as Json[])[0]?.['id'];
    const p2 = await call(
      `/buildings/${bid}/apartments?limit=1&cursor=${encodeURIComponent(String(page1['cursor']))}`,
      { cookie: `access_token=${at}` },
    );
    const secondId = (p2.body['data'] as Json[])[0]?.['id'];
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });

  ct('AR11 tampered cursor → 400 invalid_cursor', async () => {
    const at = await manager('badcur');
    const bid = await newBuilding(at);
    const r = await call(`/buildings/${bid}/apartments?cursor=nope`, {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[apartments.contract] ran against ' + API);
});
