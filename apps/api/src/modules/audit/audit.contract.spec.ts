/**
 * Phase 3 Slice 8 — Audit-Read CONTRACT conformance (BLACK-BOX).
 * Spec: docs/03 §7 (Audit-Read), D.16, D.17. Skips if unreachable.
 *
 *  AU1 unauth → 401.
 *  AU2 manager GET /audit → 200 {data:[AuditEntry],page}; the caller's
 *      own domain mutations appear (append-only trail); entries carry NO
 *      before/after diff, ip or user_agent (sensitive context withheld).
 *  AU3 there is NO write endpoint — POST /audit → 404 (append-only).
 *  AU4 bad cursor → 400 invalid_cursor.
 *  AU5 cross-tenant isolation: org B never sees org A's audit rows.
 */
import { AuditEntrySchema } from '@emapp/shared-types';
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
      org_name: 'AU Org',
      name: 'AU User',
      email: `au_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`,
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
    console.warn(`[audit.contract] API not reachable — SKIPPED.`);
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

describe('CONTRACT · audit-read', () => {
  ct('AU1 unauth → 401', async () => {
    expect((await call('/audit')).status).toBe(401);
  });

  ct('AU2 manager read → trail of own mutations, no sensitive fields', async () => {
    const at = await manager('r');
    // Generate an auditable mutation.
    await call('/projects', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'Audited P', type: 'tama38_1' }),
    });
    const r = await call('/audit', { cookie: `access_token=${at}` });
    expect(r.status).toBe(200);
    const rows = r.body['data'] as Json[];
    expect(rows.length).toBeGreaterThan(0);
    for (const e of rows) {
      expect(AuditEntrySchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
      expect(e).not.toHaveProperty('beforeState');
      expect(e).not.toHaveProperty('afterState');
      expect(e).not.toHaveProperty('ip');
      expect(e).not.toHaveProperty('userAgent');
    }
    expect(rows.some((e) => e['action'] === 'project.create')).toBe(true);
  });

  ct('AU3 append-only — POST /audit → 404 (no write endpoint)', async () => {
    const at = await manager('w');
    const r = await call('/audit', {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ action: 'x' }),
    });
    expect(r.status).toBe(404);
  });

  ct('AU4 bad cursor → 400 invalid_cursor', async () => {
    const at = await manager('c');
    const r = await call('/audit?cursor=nope', { cookie: `access_token=${at}` });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });

  ct('AU5 cross-tenant: org B never sees org A audit rows', async () => {
    const a = await manager('iso-a');
    await call('/projects', {
      method: 'POST',
      cookie: `access_token=${a}`,
      body: JSON.stringify({ name: 'A secret', type: 'tama38_1' }),
    });
    const b = await manager('iso-b');
    const rb = await call('/audit', { cookie: `access_token=${b}` });
    expect(rb.status).toBe(200);
    // org B is fresh → no project.create from A leaks in.
    expect((rb.body['data'] as Json[]).every((e) => e['action'] !== 'project.create')).toBe(true);
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[audit.contract] ran against ' + API);
});
