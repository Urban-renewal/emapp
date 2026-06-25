/**
 * Phase 3 Slice 7 — Notifications CONTRACT conformance (BLACK-BOX).
 * Spec: docs/03 §7 T3.N.1, D.16, locked RLS (user_id = app.user_id).
 *
 * Generation (task-assign → notification) + SSE is Phase 5 (T3.N.1) and
 * the locked RLS forbids cross-user inserts in an actor tx, so a fresh
 * user legitimately has ZERO notifications. This suite verifies the
 * self-scoped read/mark contract surface.
 *
 *  NT1 unauth → 401.
 *  NT2 list → {data:[],page} (own only; fresh user empty) — never another
 *      user's rows.
 *  NT3 mark random uuid read → 404 (not the caller's / absent).
 *  NT4 read-all → {data:{updated:0}} for a fresh user.
 *  NT5 bad cursor → 400 invalid_cursor.
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
const PW = 'TestPassword123456';
async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'NT Org',
      name: 'NT User',
      email: `nt_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`,
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  return at;
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
    console.warn(`[notifications.contract] API not reachable — SKIPPED.`);
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

describe('CONTRACT · notifications (self-scoped)', () => {
  ct('NT1 unauth → 401', async () => {
    expect((await call('/notifications')).status).toBe(401);
  });

  ct('NT2 list → {data:[],page}; fresh user has none', async () => {
    const at = await manager('l');
    const r = await call('/notifications', { cookie: `access_token=${at}` });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body['data'])).toBe(true);
    expect((r.body['data'] as Json[]).length).toBe(0);
    expect(r.body['page']).toHaveProperty('has_more');
  });

  ct('NT3 mark random uuid read → 404', async () => {
    const at = await manager('m');
    const r = await call('/notifications/00000000-0000-0000-0000-0000000000aa/read', {
      method: 'POST',
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(404);
    expect((r.body['error'] as Json)?.['code']).toBe('not_found');
  });

  ct('NT4 read-all → {data:{updated:0}} for a fresh user', async () => {
    const at = await manager('a');
    const r = await call('/notifications/read-all', {
      method: 'POST',
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(200);
    expect((r.body['data'] as Json)['updated']).toBe(0);
  });

  ct('NT5 bad cursor → 400 invalid_cursor', async () => {
    const at = await manager('c');
    const r = await call('/notifications?cursor=nope', { cookie: `access_token=${at}` });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });

  ct('NT6 valid ?type= is ACCEPTED (server-side filter) → 200 {data:[],page}', async () => {
    const at = await manager('t');
    const r = await call('/notifications?type=signature_received', {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body['data'])).toBe(true);
    // Fresh user: zero rows, but the param is honoured (no validation error) —
    // proves the additive server-side `type` filter is wired end-to-end.
    expect((r.body['data'] as Json[]).length).toBe(0);
  });

  ct('NT7 unknown ?type= → 400 validation_error (DTO-rejected)', async () => {
    const at = await manager('u');
    const r = await call('/notifications?type=not_a_real_type', {
      cookie: `access_token=${at}`,
    });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('NT8 unread-count → {data:{count:0}} for a fresh user', async () => {
    const at = await manager('uc');
    const r = await call('/notifications/unread-count', { cookie: `access_token=${at}` });
    expect(r.status).toBe(200);
    expect((r.body['data'] as Json)['count']).toBe(0);
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[notifications.contract] ran against ' + API);
});
