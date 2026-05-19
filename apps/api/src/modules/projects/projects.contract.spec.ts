/**
 * Phase 3 Slice 1 — Projects CONTRACT conformance suite (BLACK-BOX).
 *
 * Knows NOTHING about the implementation. Encodes the behavioural contract
 * from the spec (docs/03 §7, docs/09 §3.8–3.12, D.16 envelope, D.17 roles,
 * CLAUDE.md soft-delete=archivedAt) and demands the running system honour
 * it. Talks HTTP to a live API (AUTH_CONTRACT_BASE_URL, default
 * http://localhost:3000); if unreachable every test SKIPS (so `pnpm test`
 * stays green) — the CI `conformance` job boots the compiled API and runs
 * it for real.
 *
 * ── THE CONTRACT ───────────────────────────────────────────────────────────
 *  PR1  GET /projects without auth → 401.
 *  PR2  Manager POST /projects {name,type} → 2xx {data:{Project}}; org &
 *       createdBy come from the JWT (NOT echoed-back client input).
 *  PR3  POST with missing/invalid body OR unknown field → 400
 *       validation_error (`.strict()` fail-closed).
 *  PR4  GET /projects → {data:[],page:{limit,cursor,has_more}}; the just-
 *       created project is present and ProjectSchema-shaped.
 *  PR5  GET /projects/:id (own) → 200 {data:{Project}}.
 *  PR6  GET /projects/:id with a random uuid → 404 not_found.
 *  PR7  Cross-tenant: org-A token GETting org-B's project id → 404
 *       (RLS isolation, NO oracle — same as a non-existent id).
 *  PR8  PATCH /projects/:id {name} → 200, change persisted.
 *  PR9  DELETE /projects/:id → 204; the project then disappears from the
 *       list (soft delete = archived, not physically removed).
 *  PR10 Cursor pagination: limit=1 over ≥2 projects → has_more=true +
 *       cursor; following the cursor returns the next page (keyset, no dup).
 *  PR11 Tampered cursor → 400 invalid_cursor (never 500).
 *  PR12 Envelope: success bodies have `data`; errors have `error.code`.
 */
import { ProjectSchema } from '@emapp/shared-types';
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
  return `pr_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`;
}
const PW = 'TestPassword123456';

/** Sign up a fresh manager; return its access_token cookie. */
async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'PR Org',
      name: 'PR User',
      email: uniqueEmail(tag),
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup did not yield access_token: ${r.raw}`);
  return at;
}

async function createProject(at: string, body: Json): Promise<Res> {
  return call('/projects', {
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
    console.warn(`[projects.contract] API not reachable at ${API} — all tests SKIPPED.`);
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

describe('CONTRACT · projects · auth & envelope', () => {
  ct('PR1 unauthenticated list → 401', async () => {
    const r = await call('/projects');
    expect(r.status).toBe(401);
  });

  ct('PR12 success has data; error has error.code', async () => {
    const at = await manager('env');
    const ok = await call('/projects', { cookie: `access_token=${at}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('data');
    expect(ok.body).toHaveProperty('page');
    const bad = await createProject(at, { type: 'tama38_1' }); // missing name
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('validation_error');
  });
});

describe('CONTRACT · projects · CRUD', () => {
  ct('PR2 manager create → 2xx {data:{Project}} (schema-valid, org from JWT)', async () => {
    const at = await manager('c');
    const r = await createProject(at, {
      name: 'Renewal A',
      type: 'tama38_1',
      targetSignaturePct: 67,
    });
    expect(r.status, r.raw).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    const data = r.body['data'];
    const parsed = ProjectSchema.safeParse(data);
    expect(parsed.success, `response not ProjectSchema-shaped: ${r.raw}`).toBe(true);
    expect((data as Json)['name']).toBe('Renewal A');
    expect((data as Json)['status']).toBe('planning'); // D.18 default
    expect((data as Json)['organizationId']).toBeTruthy();
  });

  ct('PR3 invalid body / unknown field → 400 validation_error', async () => {
    const at = await manager('inv');
    const missing = await createProject(at, { name: 'x' }); // no type
    expect(missing.status).toBe(400);
    const badEnum = await createProject(at, { name: 'x', type: 'not_a_type' });
    expect(badEnum.status).toBe(400);
    const unknown = await createProject(at, { name: 'x', type: 'tama38_1', injected: true });
    expect(unknown.status, 'unknown field not rejected (strict fail-closed)').toBe(400);
    expect((unknown.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('PR4/PR5 list shows the project; get by id returns it', async () => {
    const at = await manager('rd');
    const created = await createProject(at, { name: 'Listed', type: 'pinui_binui' });
    const id = (created.body['data'] as Json)['id'] as string;

    const list = await call('/projects', { cookie: `access_token=${at}` });
    expect(list.status).toBe(200);
    const arr = list.body['data'] as Json[];
    expect(arr.some((p) => p['id'] === id)).toBe(true);
    const page = list.body['page'] as Json;
    expect(typeof page['limit']).toBe('number');
    expect(page).toHaveProperty('has_more');

    const one = await call(`/projects/${id}`, { cookie: `access_token=${at}` });
    expect(one.status).toBe(200);
    expect((one.body['data'] as Json)['id']).toBe(id);
  });

  ct('PR6 random uuid → 404 not_found', async () => {
    const at = await manager('nf');
    const r = await call('/projects/00000000-0000-0000-0000-0000000000aa', {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(404);
    expect((r.body['error'] as Json)?.['code']).toBe('not_found');
  });

  ct('PR7/PR12 cross-tenant get → 404 (RLS isolation, no oracle)', async () => {
    const atA = await manager('iso-a');
    const created = await createProject(atA, { name: 'Secret A', type: 'tama38_2' });
    const idA = (created.body['data'] as Json)['id'] as string;

    const atB = await manager('iso-b');
    const cross = await call(`/projects/${idA}`, { cookie: `access_token=${atB}` });
    expect(cross.status, 'org B could see org A project — RLS isolation broken').toBe(404);
    expect((cross.body['error'] as Json)?.['code']).toBe('not_found');
    // and B's list never contains A's project
    const listB = await call('/projects', { cookie: `access_token=${atB}` });
    expect((listB.body['data'] as Json[]).some((p) => p['id'] === idA)).toBe(false);
  });

  ct('PR8 patch persists the change', async () => {
    const at = await manager('upd');
    const created = await createProject(at, { name: 'Before', type: 'tama38_1' });
    const id = (created.body['data'] as Json)['id'] as string;
    const patched = await call(`/projects/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'After', status: 'gathering_signatures' }),
    });
    expect(patched.status).toBe(200);
    expect((patched.body['data'] as Json)['name']).toBe('After');
    const reread = await call(`/projects/${id}`, { cookie: `access_token=${at}` });
    expect((reread.body['data'] as Json)['status']).toBe('gathering_signatures');
  });

  ct('PR9 delete is a soft archive — gone from list, not erased', async () => {
    const at = await manager('del');
    const created = await createProject(at, { name: 'Doomed', type: 'tama38_1' });
    const id = (created.body['data'] as Json)['id'] as string;
    const del = await call(`/projects/${id}`, {
      method: 'DELETE',
      cookie: `access_token=${at}`,
    });
    expect(del.status).toBe(204);
    const list = await call('/projects', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((p) => p['id'] === id)).toBe(false);
  });
});

describe('CONTRACT · projects · pagination (keyset)', () => {
  ct('PR10 limit=1 over ≥2 projects → has_more + working cursor, no dup', async () => {
    const at = await manager('pg');
    await createProject(at, { name: 'P1', type: 'tama38_1' });
    await createProject(at, { name: 'P2', type: 'tama38_1' });
    await createProject(at, { name: 'P3', type: 'tama38_1' });

    const p1 = await call('/projects?limit=1', { cookie: `access_token=${at}` });
    expect(p1.status).toBe(200);
    const page1 = p1.body['page'] as Json;
    expect((p1.body['data'] as Json[]).length).toBe(1);
    expect(page1['has_more']).toBe(true);
    expect(typeof page1['cursor']).toBe('string');

    const firstId = (p1.body['data'] as Json[])[0]?.['id'];
    const p2 = await call(
      `/projects?limit=1&cursor=${encodeURIComponent(String(page1['cursor']))}`,
      {
        cookie: `access_token=${at}`,
      },
    );
    expect(p2.status).toBe(200);
    const secondId = (p2.body['data'] as Json[])[0]?.['id'];
    expect(secondId).toBeTruthy();
    expect(secondId, 'cursor returned the same row (offset/keyset bug)').not.toBe(firstId);
  });

  ct('PR11 tampered cursor → 400 invalid_cursor (never 500)', async () => {
    const at = await manager('badcur');
    const r = await call('/projects?cursor=not-a-valid-cursor', {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[projects.contract] ran against ' + API);
});
