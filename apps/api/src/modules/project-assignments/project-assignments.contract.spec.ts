/**
 * Phase 3 Slice 9 — ProjectAssignments CONTRACT conformance (BLACK-BOX).
 * Spec: docs/03 §7 (Project-Assignments / T3.PA.1), D.16, D.17.
 *
 *  PA1 unauth → 401.
 *  PA2 manager assign self (org member) → 2xx {data:{ProjectAssignment}}.
 *  PA3 invalid userId (not a member) → 400 invalid_assignee.
 *  PA4 duplicate active (project,user) → 409 assignment_exists.
 *  PA5 list shows it; PA6 unknown project → 404; PA7 cross-tenant → 404.
 *  PA8 unassign → 204, off the active list (re-assignable after).
 *  PA9 bad cursor → 400 invalid_cursor.
 */
import { ProjectAssignmentSchema } from '@emapp/shared-types';
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
async function manager(tag: string): Promise<{ at: string; uid: string }> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'PA Org',
      name: 'PA User',
      email: `pa_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`,
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  const me = await call('/me', { cookie: `access_token=${at}` });
  return { at, uid: (me.body['data'] as Json)['id'] as string };
}
async function newProject(at: string): Promise<string> {
  const r = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ name: 'PA P', type: 'tama38_1' }),
  });
  return (r.body['data'] as Json)['id'] as string;
}
async function assign(at: string, pid: string, body: Json): Promise<Res> {
  return call(`/projects/${pid}/assignments`, {
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
    console.warn(`[project-assignments.contract] API not reachable — SKIPPED.`);
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

describe('CONTRACT · project-assignments', () => {
  ct('PA1 unauth → 401', async () => {
    expect((await call('/projects/00000000-0000-0000-0000-0000000000aa/assignments')).status).toBe(
      401,
    );
  });

  ct('PA2 manager assign self → 2xx schema-valid', async () => {
    const { at, uid } = await manager('c');
    const pid = await newProject(at);
    const r = await assign(at, pid, { userId: uid, roleInProject: 'agent' });
    expect(r.status, r.raw).toBeLessThan(300);
    expect(ProjectAssignmentSchema.safeParse(r.body['data']).success, r.raw).toBe(true);
    expect((r.body['data'] as Json)['userId']).toBe(uid);
  });

  ct('PA3 invalid (non-member) userId → 400 invalid_assignee', async () => {
    const { at } = await manager('inv');
    const pid = await newProject(at);
    const r = await assign(at, pid, { userId: '00000000-0000-0000-0000-0000000000bb' });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_assignee');
  });

  ct('PA4 duplicate active → 409 assignment_exists', async () => {
    const { at, uid } = await manager('dup');
    const pid = await newProject(at);
    expect((await assign(at, pid, { userId: uid })).status).toBeLessThan(300);
    const dup = await assign(at, pid, { userId: uid });
    expect(dup.status).toBe(409);
    expect((dup.body['error'] as Json)?.['code']).toBe('assignment_exists');
  });

  ct('PA5/PA6/PA7 list / unknown project / cross-tenant', async () => {
    const { at, uid } = await manager('rd');
    const pid = await newProject(at);
    await assign(at, pid, { userId: uid });
    const list = await call(`/projects/${pid}/assignments`, { cookie: `access_token=${at}` });
    expect(list.status).toBe(200);
    expect((list.body['data'] as Json[]).some((a) => a['userId'] === uid)).toBe(true);
    const nf = await call('/projects/00000000-0000-0000-0000-0000000000cc/assignments', {
      cookie: `access_token=${at}`,
    });
    expect(nf.status).toBe(404);
    const b = await manager('iso');
    const cross = await call(`/projects/${pid}/assignments`, {
      cookie: `access_token=${b.at}`,
    });
    expect(cross.status, 'cross-tenant project visible').toBe(404);
  });

  ct('PA8 unassign → 204, off list, re-assignable', async () => {
    const { at, uid } = await manager('un');
    const pid = await newProject(at);
    const c = await assign(at, pid, { userId: uid });
    const id = (c.body['data'] as Json)['id'] as string;
    const del = await call(`/assignments/${id}`, {
      method: 'DELETE',
      cookie: `access_token=${at}`,
    });
    expect(del.status).toBe(204);
    const list = await call(`/projects/${pid}/assignments`, { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((a) => a['id'] === id)).toBe(false);
    const re = await assign(at, pid, { userId: uid });
    expect(re.status, 'not re-assignable after unassign').toBeLessThan(300);
  });

  ct('PA9 bad cursor → 400 invalid_cursor', async () => {
    const { at } = await manager('cur');
    const pid = await newProject(at);
    const r = await call(`/projects/${pid}/assignments?cursor=nope`, {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[project-assignments.contract] ran against ' + API);
});
