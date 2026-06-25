/**
 * Phase 3 Slice 6 — Contractors CONTRACT conformance (BLACK-BOX).
 * Spec: docs/03 §7, docs/09 §3.14, D.16, D.17. Skips if API unreachable.
 *
 *  CN1 unauth → 401.
 *  CN2 manager create → 2xx {data:{Contractor}} schema-valid.
 *  CN3 invalid / unknown field → 400 validation_error.
 *  CN4 duplicate contactEmail same org → 409 contractor_exists.
 *  CN5 list + get; CN6 random uuid → 404; CN7 cross-tenant → 404.
 *  CN8 patch persists; CN9 delete soft-archives; CN10 bad cursor → 400.
 */
import { ContractorSchema } from '@emapp/shared-types';
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
function uniq(tag: string): string {
  return `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
const PW = 'TestPassword123456';

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'CN Org',
      name: 'CN User',
      email: `cn_${uniq(tag)}@contract.test`,
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup failed: ${r.raw}`);
  return at;
}
async function createContractor(at: string, body: Json): Promise<Res> {
  return call('/contractors', {
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
    console.warn(`[contractors.contract] API not reachable — SKIPPED.`);
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

describe('CONTRACT · contractors', () => {
  ct('CN1 unauth → 401', async () => {
    expect((await call('/contractors')).status).toBe(401);
  });

  ct('CN2 create → 2xx schema-valid', async () => {
    const at = await manager('c');
    const r = await createContractor(at, {
      name: 'Acme Bldg',
      contactEmail: `acme_${uniq('e')}@x.com`,
      contactPhone: '03-1234567',
      specialty: 'concrete',
    });
    expect(r.status, r.raw).toBeLessThan(300);
    expect(ContractorSchema.safeParse(r.body['data']).success, r.raw).toBe(true);
  });

  ct('CN3 invalid / unknown field → 400 validation_error', async () => {
    const at = await manager('inv');
    const noEmail = await createContractor(at, { name: 'x' });
    expect(noEmail.status).toBe(400);
    const badEmail = await createContractor(at, { name: 'x', contactEmail: 'not-an-email' });
    expect(badEmail.status).toBe(400);
    const unknown = await createContractor(at, {
      name: 'x',
      contactEmail: `u_${uniq('e')}@x.com`,
      injected: true,
    });
    expect(unknown.status, 'strict not enforced').toBe(400);
    expect((unknown.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('CN4 duplicate contactEmail same org → 409 contractor_exists', async () => {
    const at = await manager('dup');
    const email = `dup_${uniq('e')}@x.com`;
    expect((await createContractor(at, { name: 'A', contactEmail: email })).status).toBeLessThan(
      300,
    );
    const dup = await createContractor(at, { name: 'B', contactEmail: email });
    expect(dup.status).toBe(409);
    expect((dup.body['error'] as Json)?.['code']).toBe('contractor_exists');
  });

  ct('CN5/CN6/CN7 get/list, 404, cross-tenant', async () => {
    const at = await manager('rd');
    const c = await createContractor(at, { name: 'Listed', contactEmail: `l_${uniq('e')}@x.com` });
    const id = (c.body['data'] as Json)['id'] as string;
    const list = await call('/contractors', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((x) => x['id'] === id)).toBe(true);
    const one = await call(`/contractors/${id}`, { cookie: `access_token=${at}` });
    expect(one.status).toBe(200);
    const nf = await call('/contractors/00000000-0000-0000-0000-0000000000aa', {
      cookie: `access_token=${at}`,
    });
    expect(nf.status).toBe(404);
    const atB = await manager('iso');
    const cross = await call(`/contractors/${id}`, { cookie: `access_token=${atB}` });
    expect(cross.status, 'cross-tenant leak').toBe(404);
  });

  ct('CN8/CN9/CN10 patch, soft-delete, bad cursor', async () => {
    const at = await manager('upd');
    const c = await createContractor(at, { name: 'Old', contactEmail: `o_${uniq('e')}@x.com` });
    const id = (c.body['data'] as Json)['id'] as string;
    const p = await call(`/contractors/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'New' }),
    });
    expect(p.status).toBe(200);
    expect((p.body['data'] as Json)['name']).toBe('New');
    const del = await call(`/contractors/${id}`, {
      method: 'DELETE',
      cookie: `access_token=${at}`,
    });
    expect(del.status).toBe(204);
    const list = await call('/contractors', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((x) => x['id'] === id)).toBe(false);
    const bad = await call('/contractors?cursor=nope', { cookie: `access_token=${at}` });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });

  ct('CN11 list — server-side q (name) + specialty filter + derived facet', async () => {
    const at = await manager('flt');
    const tag = uniq('s');
    // Two contractors with DISTINCT names + specialties so the filter is provable.
    const elName = `Electric-${tag}`;
    const archName = `Architect-${tag}`;
    const elSpec = `electrical-${tag}`;
    const archSpec = `architecture-${tag}`;
    await createContractor(at, {
      name: elName,
      contactEmail: `el_${tag}@x.com`,
      specialty: elSpec,
    });
    await createContractor(at, {
      name: archName,
      contactEmail: `ar_${tag}@x.com`,
      specialty: archSpec,
    });

    // q matches ONLY the electrician (server-side ILIKE, case-insensitive).
    const byName = await call(`/contractors?q=${encodeURIComponent('electric-' + tag)}`, {
      cookie: `access_token=${at}`,
    });
    expect(byName.status).toBe(200);
    const names = (byName.body['data'] as Json[]).map((x) => x['name']);
    expect(names).toContain(elName);
    expect(names).not.toContain(archName);

    // specialty filters to the EXACT value.
    const bySpec = await call(`/contractors?specialty=${encodeURIComponent(archSpec)}`, {
      cookie: `access_token=${at}`,
    });
    expect(bySpec.status).toBe(200);
    const specNames = (bySpec.body['data'] as Json[]).map((x) => x['name']);
    expect(specNames).toContain(archName);
    expect(specNames).not.toContain(elName);

    // The list carries the data-derived specialty facet (whole-org distinct),
    // which includes BOTH specialties even when a filter narrowed the page.
    const facet = (bySpec.body['facets'] as Json | undefined)?.['specialties'] as
      | string[]
      | undefined;
    expect(Array.isArray(facet)).toBe(true);
    expect(facet).toContain(elSpec);
    expect(facet).toContain(archSpec);
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[contractors.contract] ran against ' + API);
});
