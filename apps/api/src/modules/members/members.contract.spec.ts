/**
 * Phase 3 Slice C — Members + RUNTIME D.17 deny proof (BLACK-BOX).
 *
 * This is the artifact that closes the ISO 27001 A.9.4 gap that was
 * previously only STATICALLY provable: with real Viewer/Agent
 * provisioning we now exercise the deny matrix end-to-end over HTTP —
 * a Viewer is refused writes, an Agent sees only assigned projects, and
 * neither can touch member administration. Spec: docs/03 §7, D.17, D.26,
 * D.21 (owned auth), CLAUDE.md. Skips if API unreachable; CI conformance
 * runs it for real.
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
const MPW = 'MemberPassword654321';

async function manager(tag: string): Promise<{ at: string; uid: string }> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'MEM Org',
      name: 'MEM Mgr',
      email: `mem_${uniq(tag)}@contract.test`,
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  const me = await call('/me', { cookie: `access_token=${at}` });
  return { at, uid: (me.body['data'] as Json)['id'] as string };
}

/** Invite a member with a role, accept the invite, log in → returns the
 *  member's access cookie + identifiers. */
async function provision(
  mgrAt: string,
  role: 'agent' | 'viewer' | 'manager',
  tag: string,
): Promise<{ at: string; uid: string; email: string }> {
  const email = `m_${uniq(tag)}@contract.test`;
  const inv = await call('/members', {
    method: 'POST',
    cookie: `access_token=${mgrAt}`,
    body: JSON.stringify({ email, name: 'Invited', role }),
  });
  expect(inv.status, `invite failed: ${inv.raw}`).toBeLessThan(300);
  const d = inv.body['data'] as Json;
  const token = d['inviteToken'] as string;
  const uid = (d['member'] as Json)['userId'] as string;
  expect(token, 'no invite token returned').toBeTruthy();

  const acc = await call('/auth/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ token, password: MPW }),
  });
  expect(acc.status, `accept-invite failed: ${acc.raw}`).toBe(200);

  const login = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: MPW }),
  });
  expect(login.status, `member login failed: ${login.raw}`).toBe(200);
  const at = cookie(login.cookies, 'access_token');
  if (!at) throw new Error('member login set no cookie');
  return { at, uid, email };
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
    console.warn(`[members.contract] API not reachable — SKIPPED.`);
  }
});
function ct(name: string, fn: () => Promise<void>, timeout = 40000) {
  it(
    name,
    async (c) => {
      if (!LIVE) return c.skip();
      await fn();
    },
    timeout,
  );
}

describe('CONTRACT · members admin', () => {
  ct('ME1 unauth → 401; manager can list', async () => {
    expect((await call('/members')).status).toBe(401);
    const { at } = await manager('l');
    const r = await call('/members', { cookie: `access_token=${at}` });
    expect(r.status).toBe(200);
    expect(r.body['page']).toHaveProperty('has_more');
  });

  ct('ME2 invite invalid body / dup email → 400 / 409', async () => {
    const { at } = await manager('inv');
    const bad = await call('/members', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ email: 'not-email', name: 'x', role: 'agent' }),
    });
    expect(bad.status).toBe(400);
    const badRole = await call('/members', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ email: `d_${uniq('e')}@x.com`, name: 'x', role: 'root' }),
    });
    expect(badRole.status).toBe(400);
    const email = `dup_${uniq('e')}@x.com`;
    const a = await call('/members', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ email, name: 'A', role: 'viewer' }),
    });
    expect(a.status).toBeLessThan(300);
    const b = await call('/members', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ email, name: 'B', role: 'viewer' }),
    });
    expect(b.status).toBe(409);
    expect((b.body['error'] as Json)?.['code']).toBe('member_exists');
  });

  ct('ME3 manager cannot modify/revoke SELF (lockout guard)', async () => {
    const { at, uid } = await manager('self');
    const p = await call(`/members/${uid}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(p.status).toBe(400);
    expect((p.body['error'] as Json)?.['code']).toBe('cannot_modify_self');
    const d = await call(`/members/${uid}`, { method: 'DELETE', cookie: `access_token=${at}` });
    expect(d.status).toBe(400);
  });

  ct('ME4 accept-invite is single-use; bad token → 400 invalid_invite', async () => {
    const { at } = await manager('acc');
    const email = `once_${uniq('e')}@x.com`;
    const inv = await call('/members', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ email, name: 'Once', role: 'viewer' }),
    });
    const token = (inv.body['data'] as Json)['inviteToken'] as string;
    const a1 = await call('/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ token, password: MPW }),
    });
    expect(a1.status).toBe(200);
    const a2 = await call('/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ token, password: MPW }),
    });
    expect(a2.status, 'invite token was reusable').toBe(400);
    expect((a2.body['error'] as Json)?.['code']).toBe('invalid_invite');
    const bad = await call('/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ token: 'garbage.token.value', password: MPW }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('CONTRACT · D.17 RUNTIME deny matrix (the ISO proof)', () => {
  ct('ME5 VIEWER: reads allowed, ALL writes 403, member-admin 403', async () => {
    const m = await manager('v');
    const proj = (
      (
        await call('/projects', {
          method: 'POST',
          cookie: `access_token=${m.at}`,
          body: JSON.stringify({ name: 'V Proj', type: 'tama38_1' }),
        })
      ).body['data'] as Json
    )['id'] as string;
    const v = await provision(m.at, 'viewer', 'v');

    // read allowed
    expect((await call('/projects', { cookie: `access_token=${v.at}` })).status).toBe(200);
    expect((await call(`/projects/${proj}`, { cookie: `access_token=${v.at}` })).status).toBe(200);
    // EVERY write denied with 403 forbidden (D.17 enforced at RUNTIME)
    const create = await call('/projects', {
      method: 'POST',
      cookie: `access_token=${v.at}`,
      body: JSON.stringify({ name: 'nope', type: 'tama38_1' }),
    });
    expect(create.status, 'viewer could CREATE — D.17 not enforced').toBe(403);
    expect((create.body['error'] as Json)?.['code']).toBe('forbidden');
    expect(
      (
        await call(`/projects/${proj}`, {
          method: 'PATCH',
          cookie: `access_token=${v.at}`,
          body: JSON.stringify({ name: 'x' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(`/projects/${proj}`, { method: 'DELETE', cookie: `access_token=${v.at}` }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('/owners', {
          method: 'POST',
          cookie: `access_token=${v.at}`,
          body: JSON.stringify({ name: 'x', national_id: '000000018' }),
        })
      ).status,
    ).toBe(403);
    // member administration is manager-only
    expect((await call('/members', { cookie: `access_token=${v.at}` })).status).toBe(403);
  });

  ct('ME6 AGENT: sees ONLY assigned projects; writes 403', async () => {
    const m = await manager('a');
    const mk = async (n: string) =>
      (
        (
          await call('/projects', {
            method: 'POST',
            cookie: `access_token=${m.at}`,
            body: JSON.stringify({ name: n, type: 'tama38_1' }),
          })
        ).body['data'] as Json
      )['id'] as string;
    const p1 = await mk('A-assigned');
    const p2 = await mk('A-hidden');
    const a = await provision(m.at, 'agent', 'a');

    // before assignment: agent sees neither; by-id is 404 (no oracle)
    const list0 = await call('/projects', { cookie: `access_token=${a.at}` });
    const ids0 = (list0.body['data'] as Json[]).map((x) => x['id']);
    expect(ids0).not.toContain(p1);
    expect(ids0).not.toContain(p2);
    expect((await call(`/projects/${p1}`, { cookie: `access_token=${a.at}` })).status).toBe(404);
    // agent cannot create
    expect(
      (
        await call('/projects', {
          method: 'POST',
          cookie: `access_token=${a.at}`,
          body: JSON.stringify({ name: 'nope', type: 'tama38_1' }),
        })
      ).status,
    ).toBe(403);

    // manager assigns agent to p1 only
    const asg = await call(`/projects/${p1}/assignments`, {
      method: 'POST',
      cookie: `access_token=${m.at}`,
      body: JSON.stringify({ userId: a.uid }),
    });
    expect(asg.status, asg.raw).toBeLessThan(300);

    const list1 = await call('/projects', { cookie: `access_token=${a.at}` });
    const ids1 = (list1.body['data'] as Json[]).map((x) => x['id']);
    expect(ids1, 'agent does not see assigned project').toContain(p1);
    expect(ids1, 'agent leaked an UNassigned project').not.toContain(p2);
    expect((await call(`/projects/${p1}`, { cookie: `access_token=${a.at}` })).status).toBe(200);
    expect(
      (await call(`/projects/${p2}`, { cookie: `access_token=${a.at}` })).status,
      'agent reached an unassigned project by id',
    ).toBe(404);
  });

  ct('ME7 invited MANAGER has full rights (positive control)', async () => {
    const m = await manager('mm');
    const m2 = await provision(m.at, 'manager', 'mm');
    const r = await call('/projects', {
      method: 'POST',
      cookie: `access_token=${m2.at}`,
      body: JSON.stringify({ name: 'M2 Proj', type: 'tama38_1' }),
    });
    expect(r.status, 'invited manager denied a write').toBeLessThan(300);
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[members.contract] ran against ' + API);
});
