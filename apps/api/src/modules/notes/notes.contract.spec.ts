/**
 * Phase 3 Slice 8 — Notes CONTRACT conformance (BLACK-BOX).
 * Spec: docs/03 §7, D.16, D.17. Skips if unreachable.
 *
 *  NO1 unauth → 401.
 *  NO2 create → 2xx {data:{Note}} schema-valid (pinned boolean round-trip).
 *  NO3 invalid / unknown field → 400 validation_error.
 *  NO4 note on unknown project → 404 (no oracle).
 *  NO5 list + get; NO6 random uuid → 404; NO7 cross-tenant → 404.
 *  NO8 patch body/pinned persists; NO9 soft delete; NO10 bad cursor → 400.
 */
import { NoteSchema } from '@emapp/shared-types';
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
const PW = 'TestPassword123456';
async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'NO Org',
      name: 'NO User',
      email: `no_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`,
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  return at;
}
async function createNote(at: string, body: Json): Promise<Res> {
  return call('/notes', {
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
    console.warn(`[notes.contract] API not reachable — SKIPPED.`);
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

describe('CONTRACT · notes', () => {
  ct('NO1 unauth → 401', async () => {
    expect((await call('/notes')).status).toBe(401);
  });

  ct('NO2 create → 2xx schema-valid; pinned round-trips', async () => {
    const at = await manager('c');
    const r = await createNote(at, { body: 'תיאום פגישה', pinned: true });
    expect(r.status, r.raw).toBeLessThan(300);
    const d = r.body['data'] as Json;
    expect(NoteSchema.safeParse(d).success, r.raw).toBe(true);
    expect(d['pinned']).toBe(true);
  });

  ct('NO3 invalid / unknown field → 400', async () => {
    const at = await manager('inv');
    expect((await createNote(at, {})).status).toBe(400);
    expect((await createNote(at, { body: '' })).status).toBe(400);
    const u = await createNote(at, { body: 'x', injected: true });
    expect(u.status, 'strict not enforced').toBe(400);
    expect((u.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('NO4 note on unknown project → 404', async () => {
    const at = await manager('fp');
    const r = await createNote(at, {
      body: 'x',
      projectId: '00000000-0000-0000-0000-0000000000bb',
    });
    expect(r.status).toBe(404);
  });

  ct('NO5/NO6/NO7 list/get/404/cross-tenant', async () => {
    const at = await manager('rd');
    const c = await createNote(at, { body: 'Listed' });
    const id = (c.body['data'] as Json)['id'] as string;
    const list = await call('/notes', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((n) => n['id'] === id)).toBe(true);
    expect((await call(`/notes/${id}`, { cookie: `access_token=${at}` })).status).toBe(200);
    expect(
      (await call('/notes/00000000-0000-0000-0000-0000000000aa', { cookie: `access_token=${at}` }))
        .status,
    ).toBe(404);
    const b = await manager('iso');
    expect(
      (await call(`/notes/${id}`, { cookie: `access_token=${b}` })).status,
      'cross-tenant leak',
    ).toBe(404);
  });

  ct('NO8/NO9/NO10 patch, soft-delete, bad cursor', async () => {
    const at = await manager('upd');
    const c = await createNote(at, { body: 'Old', pinned: false });
    const id = (c.body['data'] as Json)['id'] as string;
    const p = await call(`/notes/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ body: 'New', pinned: true }),
    });
    expect(p.status).toBe(200);
    expect((p.body['data'] as Json)['body']).toBe('New');
    expect((p.body['data'] as Json)['pinned']).toBe(true);
    expect(
      (await call(`/notes/${id}`, { method: 'DELETE', cookie: `access_token=${at}` })).status,
    ).toBe(204);
    const list = await call('/notes', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((n) => n['id'] === id)).toBe(false);
    const bad = await call('/notes?cursor=nope', { cookie: `access_token=${at}` });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[notes.contract] ran against ' + API);
});
