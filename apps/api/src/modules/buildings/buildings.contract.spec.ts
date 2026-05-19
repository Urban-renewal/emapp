/**
 * Phase 3 Slice 2 — Buildings CONTRACT conformance suite (BLACK-BOX).
 *
 * Spec-derived (docs/03 §7, docs/09 §3.13, D.16, D.17, CLAUDE.md
 * soft-delete=archivedAt, via-parent tenant isolation). Talks HTTP to a
 * live API; skips if unreachable (CI `conformance` runs it for real).
 *
 *  BR1  Unauthenticated → 401.
 *  BR2  Manager create under own project → 2xx {data:{Building}}
 *       (BuildingSchema-shaped; projectId from URL).
 *  BR3  Invalid/unknown-field body → 400 validation_error (strict).
 *  BR4  Create under a foreign / unknown project → 404 not_found
 *       (no oracle — via-parent isolation).
 *  BR5  List shows it; GET /buildings/:id returns it.
 *  BR6  GET random uuid → 404 not_found.
 *  BR7  Cross-tenant GET of another org's building → 404.
 *  BR8  PATCH persists.
 *  BR9  DELETE → 204; gone from the project's list (soft archive).
 *  BR10 Keyset pagination: limit=1 over ≥2 → has_more + working cursor.
 *  BR11 Tampered cursor → 400 invalid_cursor.
 */
import { BuildingSchema } from '@emapp/shared-types';
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
  return `br_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`;
}
const PW = 'TestPassword123456';

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'BR Org',
      name: 'BR User',
      email: uniqueEmail(tag),
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup did not yield access_token: ${r.raw}`);
  return at;
}

async function newProject(at: string): Promise<string> {
  const r = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ name: 'Host Project', type: 'tama38_1' }),
  });
  return (r.body['data'] as Json)['id'] as string;
}

async function createBuilding(at: string, projectId: string, body: Json): Promise<Res> {
  return call(`/projects/${projectId}/buildings`, {
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
    console.warn(`[buildings.contract] API not reachable at ${API} — all tests SKIPPED.`);
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

describe('CONTRACT · buildings · auth', () => {
  ct('BR1 unauthenticated list → 401', async () => {
    const r = await call('/projects/00000000-0000-0000-0000-0000000000aa/buildings');
    expect(r.status).toBe(401);
  });
});

describe('CONTRACT · buildings · CRUD', () => {
  ct('BR2 manager create → 2xx {data:{Building}} schema-valid', async () => {
    const at = await manager('c');
    const pid = await newProject(at);
    const r = await createBuilding(at, pid, { address: 'הרצל 1', city: 'תל אביב' });
    expect(r.status, r.raw).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    const data = r.body['data'];
    expect(BuildingSchema.safeParse(data).success, `not BuildingSchema: ${r.raw}`).toBe(true);
    expect((data as Json)['projectId']).toBe(pid);
  });

  ct('BR3 invalid / unknown field → 400 validation_error', async () => {
    const at = await manager('inv');
    const pid = await newProject(at);
    const missing = await createBuilding(at, pid, { address: 'x' }); // no city
    expect(missing.status).toBe(400);
    const unknown = await createBuilding(at, pid, { address: 'x', city: 'y', injected: true });
    expect(unknown.status, 'unknown field not rejected (strict)').toBe(400);
    expect((unknown.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('BR4 create under unknown/foreign project → 404 (no oracle)', async () => {
    const at = await manager('fp');
    const unknown = await createBuilding(at, '00000000-0000-0000-0000-0000000000bb', {
      address: 'a',
      city: 'b',
    });
    expect(unknown.status).toBe(404);

    const atB = await manager('fp-b');
    const pidB = await newProject(atB);
    const cross = await createBuilding(at, pidB, { address: 'a', city: 'b' });
    expect(cross.status, 'created a building under another org project').toBe(404);
  });

  ct('BR5 list shows it; get by id returns it', async () => {
    const at = await manager('rd');
    const pid = await newProject(at);
    const created = await createBuilding(at, pid, { address: 'ויצמן 5', city: 'חיפה' });
    const id = (created.body['data'] as Json)['id'] as string;

    const list = await call(`/projects/${pid}/buildings`, { cookie: `access_token=${at}` });
    expect(list.status).toBe(200);
    expect((list.body['data'] as Json[]).some((b) => b['id'] === id)).toBe(true);
    expect(list.body['page']).toHaveProperty('has_more');

    const one = await call(`/buildings/${id}`, { cookie: `access_token=${at}` });
    expect(one.status).toBe(200);
    expect((one.body['data'] as Json)['id']).toBe(id);
  });

  ct('BR6 random uuid → 404 not_found', async () => {
    const at = await manager('nf');
    const r = await call('/buildings/00000000-0000-0000-0000-0000000000cc', {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(404);
    expect((r.body['error'] as Json)?.['code']).toBe('not_found');
  });

  ct('BR7 cross-tenant get → 404 (via-parent isolation)', async () => {
    const atA = await manager('iso-a');
    const pidA = await newProject(atA);
    const created = await createBuilding(atA, pidA, { address: 'secret', city: 'x' });
    const idA = (created.body['data'] as Json)['id'] as string;

    const atB = await manager('iso-b');
    const cross = await call(`/buildings/${idA}`, { cookie: `access_token=${atB}` });
    expect(cross.status, 'org B saw org A building').toBe(404);
  });

  ct('BR8 patch persists', async () => {
    const at = await manager('upd');
    const pid = await newProject(at);
    const created = await createBuilding(at, pid, { address: 'old', city: 'c' });
    const id = (created.body['data'] as Json)['id'] as string;
    const patched = await call(`/buildings/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ address: 'new', aptCount: 12 }),
    });
    expect(patched.status).toBe(200);
    expect((patched.body['data'] as Json)['address']).toBe('new');
    expect((patched.body['data'] as Json)['aptCount']).toBe(12);
  });

  ct('BR9 delete is a soft archive — gone from list', async () => {
    const at = await manager('del');
    const pid = await newProject(at);
    const created = await createBuilding(at, pid, { address: 'doomed', city: 'c' });
    const id = (created.body['data'] as Json)['id'] as string;
    const del = await call(`/buildings/${id}`, { method: 'DELETE', cookie: `access_token=${at}` });
    expect(del.status).toBe(204);
    const list = await call(`/projects/${pid}/buildings`, { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((b) => b['id'] === id)).toBe(false);
  });
});

describe('CONTRACT · buildings · pagination', () => {
  ct('BR10 limit=1 over ≥2 → has_more + working cursor, no dup', async () => {
    const at = await manager('pg');
    const pid = await newProject(at);
    await createBuilding(at, pid, { address: 'B1', city: 'c' });
    await createBuilding(at, pid, { address: 'B2', city: 'c' });

    const p1 = await call(`/projects/${pid}/buildings?limit=1`, { cookie: `access_token=${at}` });
    const page1 = p1.body['page'] as Json;
    expect((p1.body['data'] as Json[]).length).toBe(1);
    expect(page1['has_more']).toBe(true);
    const firstId = (p1.body['data'] as Json[])[0]?.['id'];

    const p2 = await call(
      `/projects/${pid}/buildings?limit=1&cursor=${encodeURIComponent(String(page1['cursor']))}`,
      { cookie: `access_token=${at}` },
    );
    const secondId = (p2.body['data'] as Json[])[0]?.['id'];
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });

  ct('BR11 tampered cursor → 400 invalid_cursor', async () => {
    const at = await manager('badcur');
    const pid = await newProject(at);
    const r = await call(`/projects/${pid}/buildings?cursor=not-valid`, {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[buildings.contract] ran against ' + API);
});
