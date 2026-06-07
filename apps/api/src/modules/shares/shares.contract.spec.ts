/**
 * Phase 3 Slice 6 — Shares CONTRACT conformance (BLACK-BOX).
 * Spec: docs/03 §7 T3.S.1, docs/09 §3.14, D.16, D.17. Skips if unreachable.
 *
 *  SH1 unauth → 401.
 *  SH2 manager grant (valid full strict permissions) → 2xx {data:{Share}}.
 *  SH3 unknown permission key → 400 validation_error (fail-closed T3.S.1).
 *  SH4 grant referencing unknown/foreign contractor → 400 contractor_invalid.
 *  SH5 grant under foreign/unknown project → 404.
 *  SH6 duplicate active (project+contractor) → 409 share_exists.
 *  SH7 list active; SH8 PATCH replaces permissions; SH9 DELETE revokes
 *      (off the active list); SH10 bad cursor → 400.
 */
import { ShareSchema } from '@emapp/shared-types';
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

// Canonical full permissions object (byte-equivalent to the locked
// _share-permissions default). T3.S.1: this exact shape must be accepted;
// any extra key must be rejected.
const PERMS = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: false },
};

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

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'SH Org',
      name: 'SH User',
      email: `sh_${uniq(tag)}@contract.test`,
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  return at;
}
async function newProject(at: string): Promise<string> {
  const r = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ name: 'SH P', type: 'tama38_1' }),
  });
  return (r.body['data'] as Json)['id'] as string;
}
async function newContractor(at: string): Promise<string> {
  const r = await call('/contractors', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ name: 'C', contactEmail: `c_${uniq('e')}@x.com` }),
  });
  return (r.body['data'] as Json)['id'] as string;
}
async function grant(at: string, pid: string, body: Json): Promise<Res> {
  return call(`/projects/${pid}/shares`, {
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
    console.warn(`[shares.contract] API not reachable — SKIPPED.`);
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

describe('CONTRACT · shares', () => {
  ct('SH1 unauth → 401', async () => {
    expect((await call('/projects/00000000-0000-0000-0000-0000000000aa/shares')).status).toBe(401);
  });

  ct('SH2 manager grant → 2xx {data:{Share}} schema-valid', async () => {
    const at = await manager('c');
    const pid = await newProject(at);
    const cid = await newContractor(at);
    const r = await grant(at, pid, { contractorId: cid, permissions: PERMS });
    expect(r.status, r.raw).toBeLessThan(300);
    expect(ShareSchema.safeParse(r.body['data']).success, r.raw).toBe(true);
  });

  ct('SH3 unknown permission key → 400 validation_error (fail-closed)', async () => {
    const at = await manager('strict');
    const pid = await newProject(at);
    const cid = await newContractor(at);
    const bad = await grant(at, pid, {
      contractorId: cid,
      permissions: { ...PERMS, hacked: true },
    });
    expect(bad.status, 'unknown permission key not rejected').toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('validation_error');
    const badNested = await grant(at, pid, {
      contractorId: cid,
      permissions: { ...PERMS, overview: { on: true, extra: 1 } },
    });
    expect(badNested.status, 'unknown nested key not rejected').toBe(400);
  });

  ct('SH4 unknown/foreign contractor → 400 contractor_invalid', async () => {
    const at = await manager('ci');
    const pid = await newProject(at);
    const r = await grant(at, pid, {
      contractorId: '00000000-0000-0000-0000-0000000000bb',
      permissions: PERMS,
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('contractor_invalid');
    const atB = await manager('ci-b');
    const cidB = await newContractor(atB);
    const cross = await grant(at, pid, { contractorId: cidB, permissions: PERMS });
    expect(cross.status, 'used another org contractor').toBe(400);
  });

  ct('SH5 foreign/unknown project → 404', async () => {
    const at = await manager('fp');
    const cid = await newContractor(at);
    const r = await grant(at, '00000000-0000-0000-0000-0000000000cc', {
      contractorId: cid,
      permissions: PERMS,
    });
    expect(r.status).toBe(404);
  });

  ct('SH6 duplicate active project+contractor → 409 share_exists', async () => {
    const at = await manager('dup');
    const pid = await newProject(at);
    const cid = await newContractor(at);
    expect((await grant(at, pid, { contractorId: cid, permissions: PERMS })).status).toBeLessThan(
      300,
    );
    const dup = await grant(at, pid, { contractorId: cid, permissions: PERMS });
    expect(dup.status).toBe(409);
    expect((dup.body['error'] as Json)?.['code']).toBe('share_exists');
  });

  ct('SH7/SH8/SH9/SH10 list, patch perms, revoke, bad cursor', async () => {
    const at = await manager('life');
    const pid = await newProject(at);
    const cid = await newContractor(at);
    const c = await grant(at, pid, { contractorId: cid, permissions: PERMS });
    const id = (c.body['data'] as Json)['id'] as string;

    const list = await call(`/projects/${pid}/shares`, { cookie: `access_token=${at}` });
    expect(list.status).toBe(200);
    expect((list.body['data'] as Json[]).some((s) => s['id'] === id)).toBe(true);

    const patched = await call(`/shares/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ permissions: { ...PERMS, signatures: { on: true } } }),
    });
    expect(patched.status).toBe(200);
    expect(((patched.body['data'] as Json)['permissions'] as Json)['signatures']).toEqual({
      on: true,
    });

    const del = await call(`/shares/${id}`, { method: 'DELETE', cookie: `access_token=${at}` });
    expect(del.status).toBe(204);
    const after = await call(`/projects/${pid}/shares`, { cookie: `access_token=${at}` });
    expect((after.body['data'] as Json[]).some((s) => s['id'] === id)).toBe(false);

    const bad = await call(`/projects/${pid}/shares?cursor=nope`, {
      cookie: `access_token=${at}`,
    });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[shares.contract] ran against ' + API);
});
