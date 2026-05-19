/**
 * Phase 3 Slice 7 — Tasks CONTRACT conformance (BLACK-BOX).
 * Spec: docs/03 §7 T3.T.1, docs/09 §3.14, D.16, D.17. Skips if unreachable.
 *
 * NOTE: creating a non-manager (agent) user needs the invite/membership
 * endpoints which are NOT in Phase 3, so the Agent-only "sees just
 * assigned tasks" path is exercised at the SERVICE layer + later when
 * user provisioning lands (recorded). Here we cover the black-box surface
 * reachable with a manager (self is a valid org member).
 *
 *  TK1 unauth → 401.
 *  TK2 create → 2xx {data:{Task}} schema-valid (defaults: pending, prio 2).
 *  TK3 invalid / unknown field → 400 validation_error.
 *  TK4 list + get; TK5 random uuid → 404; TK6 cross-tenant → 404.
 *  TK7 PATCH status=completed sets completedAt/By; revert clears them.
 *  TK8 assignees: add self (member) → 2xx; duplicate → 409
 *      assignee_exists; random uuid → 400 invalid_assignee; list; remove
 *      → 204; remove again → 404.
 *  TK9 soft delete → 204, off the list; TK10 bad cursor → 400.
 */
import { TaskSchema } from '@emapp/shared-types';
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
function uniq(t: string): string {
  return `${t}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
const PW = 'TestPassword123456';

async function manager(tag: string): Promise<{ at: string; uid: string }> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'TK Org',
      name: 'TK User',
      email: `tk_${uniq(tag)}@contract.test`,
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  const me = await call('/me', { cookie: `access_token=${at}` });
  const uid = (me.body['data'] as Json)['id'] as string;
  return { at, uid };
}
async function createTask(at: string, body: Json): Promise<Res> {
  return call('/tasks', {
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
    console.warn(`[tasks.contract] API not reachable — SKIPPED.`);
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

describe('CONTRACT · tasks', () => {
  ct('TK1 unauth → 401', async () => {
    expect((await call('/tasks')).status).toBe(401);
  });

  ct('TK2 create → 2xx schema-valid defaults', async () => {
    const { at } = await manager('c');
    const r = await createTask(at, { title: 'Call owner' });
    expect(r.status, r.raw).toBeLessThan(300);
    const d = r.body['data'] as Json;
    expect(TaskSchema.safeParse(d).success, r.raw).toBe(true);
    expect(d['status']).toBe('pending');
    expect(d['priority']).toBe(2);
  });

  ct('TK3 invalid / unknown field → 400', async () => {
    const { at } = await manager('inv');
    expect((await createTask(at, {})).status).toBe(400);
    expect((await createTask(at, { title: 'x', priority: 9 })).status).toBe(400);
    const u = await createTask(at, { title: 'x', injected: true });
    expect(u.status, 'strict not enforced').toBe(400);
    expect((u.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('TK4/TK5/TK6 list/get/404/cross-tenant', async () => {
    const { at } = await manager('rd');
    const c = await createTask(at, { title: 'Listed' });
    const id = (c.body['data'] as Json)['id'] as string;
    const list = await call('/tasks', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((t) => t['id'] === id)).toBe(true);
    expect((await call(`/tasks/${id}`, { cookie: `access_token=${at}` })).status).toBe(200);
    const nf = await call('/tasks/00000000-0000-0000-0000-0000000000aa', {
      cookie: `access_token=${at}`,
    });
    expect(nf.status).toBe(404);
    const b = await manager('iso');
    expect(
      (await call(`/tasks/${id}`, { cookie: `access_token=${b.at}` })).status,
      'cross-tenant leak',
    ).toBe(404);
  });

  ct('TK7 status=completed sets completedAt/By; revert clears', async () => {
    const { at } = await manager('st');
    const c = await createTask(at, { title: 'Finish' });
    const id = (c.body['data'] as Json)['id'] as string;
    const done = await call(`/tasks/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(done.status).toBe(200);
    expect((done.body['data'] as Json)['completedAt']).not.toBeNull();
    expect((done.body['data'] as Json)['completedBy']).not.toBeNull();
    const reopened = await call(`/tasks/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ status: 'in_progress' }),
    });
    expect((reopened.body['data'] as Json)['completedAt']).toBeNull();
  });

  ct('TK8 assignees add/dup/invalid/list/remove', async () => {
    const { at, uid } = await manager('as');
    const c = await createTask(at, { title: 'Assign me' });
    const id = (c.body['data'] as Json)['id'] as string;
    const add = await call(`/tasks/${id}/assignees`, {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ userId: uid }),
    });
    expect(add.status, add.raw).toBeLessThan(300);
    const dup = await call(`/tasks/${id}/assignees`, {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ userId: uid }),
    });
    expect(dup.status).toBe(409);
    expect((dup.body['error'] as Json)?.['code']).toBe('assignee_exists');
    const bad = await call(`/tasks/${id}/assignees`, {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ userId: '00000000-0000-0000-0000-0000000000bb' }),
    });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('invalid_assignee');
    const list = await call(`/tasks/${id}/assignees`, { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((a) => a['userId'] === uid)).toBe(true);
    const del = await call(`/tasks/${id}/assignees/${uid}`, {
      method: 'DELETE',
      cookie: `access_token=${at}`,
    });
    expect(del.status).toBe(204);
    const del2 = await call(`/tasks/${id}/assignees/${uid}`, {
      method: 'DELETE',
      cookie: `access_token=${at}`,
    });
    expect(del2.status).toBe(404);
  });

  ct('TK9/TK10 soft delete + bad cursor', async () => {
    const { at } = await manager('del');
    const c = await createTask(at, { title: 'Doomed' });
    const id = (c.body['data'] as Json)['id'] as string;
    expect(
      (await call(`/tasks/${id}`, { method: 'DELETE', cookie: `access_token=${at}` })).status,
    ).toBe(204);
    const list = await call('/tasks', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((t) => t['id'] === id)).toBe(false);
    const bad = await call('/tasks?cursor=nope', { cookie: `access_token=${at}` });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[tasks.contract] ran against ' + API);
});
