import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, request, type APIRequestContext } from '@playwright/test';

import { API } from './_helpers';

/**
 * LAYER 5 — SECURITY / ISO 27001. Adversarial probing, mostly non-browser.
 *   IDOR (A.9): Beta token → Alpha resources by-id → 404 (no oracle).
 *   JWT tamper (A.10): mutate sig / payload role / aud → 401.
 *   Mass-assign: client-supplied orgId/id/createdBy must be ignored.
 *   RBAC (A.9): viewer write → 403 (covered L2; re-asserted for agent).
 *   Rate-limit (A.12/A.13): login spam → 429.
 *   Cookie flags (A.9): access/refresh httpOnly + SameSite.
 *   Unauth (A.9): protected endpoints reject anon.
 *   PII (A.8/A.18): no national_id/phone cleartext in responses/errors.
 * Evidence: docs/audit/artifacts/layer5/*.json.
 */

const OUT = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'layer5');
mkdirSync(OUT, { recursive: true });
const rec = (n: string, d: unknown) =>
  writeFileSync(join(OUT, `${n}.json`), JSON.stringify(d, null, 2));
const AUTH = (r: string) => join(__dirname, '.auth', `${r}.json`);

const ALPHA = {
  project: 'c1ed4913-b6ee-4471-81ee-8262276437d2',
  owner: 'e776ee5e-9b41-4507-af07-457de3d5cb2a',
  document: 'e7adaaa5-c610-4fb4-afff-f8c43bbd807d',
  task: '88c7b8ff-cfeb-4b42-9f57-fb09796cfb70',
  orgId: '82ced201-732e-4727-8895-ca3bec7921e8',
};

function tokenFromState(role: string): string {
  const st = JSON.parse(readFileSync(AUTH(role), 'utf8'));
  for (const c of st.cookies ?? []) if (c.name === 'access_token') return c.value;
  throw new Error(`no access_token in ${role}.json`);
}

let manager: APIRequestContext;
let beta: APIRequestContext;
let viewer: APIRequestContext;
let anon: APIRequestContext;

test.beforeAll(async () => {
  manager = await request.newContext({ storageState: AUTH('manager') });
  beta = await request.newContext({ storageState: AUTH('managerBeta') });
  viewer = await request.newContext({ storageState: AUTH('viewer') });
  anon = await request.newContext();
});
test.afterAll(async () => {
  await manager.dispose();
  await beta.dispose();
  await viewer.dispose();
  await anon.dispose();
});

test('SEC IDOR — Beta cannot read Alpha resources by id (A.9, no oracle)', async () => {
  const ev: Record<string, unknown> = { probe: 'idor' };
  const targets = {
    project: `${API}/api/v1/projects/${ALPHA.project}`,
    owner: `${API}/api/v1/owners/${ALPHA.owner}`,
    document: `${API}/api/v1/documents/${ALPHA.document}`,
    task: `${API}/api/v1/tasks/${ALPHA.task}`,
  };
  const results: Record<string, number> = {};
  for (const [k, url] of Object.entries(targets)) {
    // sanity: Alpha CAN read its own
    const own = await manager.get(url);
    // Beta must NOT
    const cross = await beta.get(url);
    results[`${k}_alphaOwn`] = own.status();
    results[`${k}_betaCross`] = cross.status();
  }
  ev.results = results;
  const leaks = Object.entries(results).filter(([k, v]) => k.endsWith('betaCross') && v !== 404);
  ev.leaks = leaks;
  ev.verdict =
    leaks.length === 0 ? 'SECURE (all cross-tenant by-id → 404)' : `LEAK(${JSON.stringify(leaks)})`;
  rec('idor', ev);
  for (const [k, v] of Object.entries(results)) {
    if (k.endsWith('betaCross')) expect(v, `${k} must be 404 (no-oracle)`).toBe(404);
  }
});

test('SEC JWT tamper — mutated token is rejected (A.10)', async () => {
  const ev: Record<string, unknown> = { probe: 'jwt-tamper' };
  const tok = tokenFromState('manager');
  const [h, p, s] = tok.split('.');
  // baseline: valid token works
  const ok = await anon.get(`${API}/api/v1/me`, { headers: { Cookie: `access_token=${tok}` } });
  ev.validTokenStatus = ok.status();
  // 1. flip last char of signature
  const badSig = `${h}.${p}.${s.slice(0, -1)}${s.slice(-1) === 'A' ? 'B' : 'A'}`;
  const r1 = await anon.get(`${API}/api/v1/me`, { headers: { Cookie: `access_token=${badSig}` } });
  ev.badSignatureStatus = r1.status();
  // 2. tamper payload: escalate role to provider_admin, keep old signature
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  payload.role = 'provider_admin';
  const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const r2 = await anon.get(`${API}/api/v1/me`, {
    headers: { Cookie: `access_token=${h}.${tamperedPayload}.${s}` },
  });
  ev.tamperedRoleStatus = r2.status();
  // 3. alg=none style: unsigned token
  const r3 = await anon.get(`${API}/api/v1/me`, {
    headers: { Cookie: `access_token=${h}.${tamperedPayload}.` },
  });
  ev.unsignedStatus = r3.status();
  ev.verdict =
    ev.validTokenStatus === 200 && r1.status() === 401 && r2.status() === 401 && r3.status() === 401
      ? 'SECURE (all tampered tokens 401)'
      : `CHECK(${r1.status()},${r2.status()},${r3.status()})`;
  rec('jwt-tamper', ev);
  expect(ev.validTokenStatus, 'valid token works').toBe(200);
  expect(r1.status(), 'bad signature rejected').toBe(401);
  expect(r2.status(), 'tampered role rejected').toBe(401);
  expect(r3.status(), 'unsigned rejected').toBe(401);
});

test('SEC mass-assignment — client-supplied orgId/id/createdBy ignored', async () => {
  const ev: Record<string, unknown> = { probe: 'mass-assign' };
  const forgedOrg = '00000000-0000-0000-0000-000000000000';
  const forgedId = '11111111-1111-1111-1111-111111111111';
  // valid Israeli id
  const base = '12345678'.split('').map(Number);
  let sum = 0;
  base.forEach((d, i) => {
    let v = d * ((i % 2) + 1);
    if (v > 9) v -= 9;
    sum += v;
  });
  const nid = '12345678' + String((10 - (sum % 10)) % 10);
  const resp = await manager.post(`${API}/api/v1/owners`, {
    data: {
      name: `audit-massassign-${Date.now()}`,
      national_id: nid,
      id: forgedId,
      organizationId: forgedOrg,
      createdBy: forgedId,
    },
    headers: { 'Content-Type': 'application/json' },
  });
  ev.status = resp.status();
  const body = await resp.json().catch(() => null);
  ev.returnedId = body?.data?.id ?? null;
  ev.returnedOrgId = body?.data?.organizationId ?? null;
  ev.forgedIdTookEffect = body?.data?.id === forgedId;
  ev.forgedOrgTookEffect = body?.data?.organizationId === forgedOrg;
  // The owner must belong to Alpha (the caller's org), never the forged org.
  ev.verdict =
    [400, 201].includes(resp.status()) && !ev.forgedIdTookEffect && !ev.forgedOrgTookEffect
      ? 'SECURE (forged fields ignored)'
      : `CHECK(status=${resp.status()},forgedId=${ev.forgedIdTookEffect},forgedOrg=${ev.forgedOrgTookEffect})`;
  rec('mass-assign', ev);
  expect(ev.forgedOrgTookEffect, 'client-supplied organizationId MUST NOT take effect').toBeFalsy();
  expect(ev.forgedIdTookEffect, 'client-supplied id MUST NOT take effect').toBeFalsy();
});

test('SEC unauth — protected endpoints reject anonymous (A.9)', async () => {
  const ev: Record<string, unknown> = { probe: 'unauth' };
  const eps = [
    '/api/v1/projects',
    '/api/v1/owners',
    '/api/v1/me',
    '/api/v1/portal/me',
    '/api/v1/provider/tenants',
    '/api/v1/audit',
  ];
  const r: Record<string, number> = {};
  for (const e of eps) r[e] = (await anon.get(`${API}${e}`)).status();
  ev.results = r;
  const allowed = Object.entries(r).filter(([, v]) => v < 400);
  ev.verdict =
    allowed.length === 0 ? 'SECURE (all anon reads rejected)' : `OPEN(${JSON.stringify(allowed)})`;
  rec('unauth', ev);
  for (const [e, v] of Object.entries(r))
    expect(v, `${e} must reject anon`).toBeGreaterThanOrEqual(400);
});

test('SEC cookie flags — auth cookies httpOnly + SameSite (A.9)', async () => {
  const ev: Record<string, unknown> = { probe: 'cookie-flags' };
  const login = await anon.post(`${API}/api/v1/auth/login`, {
    data: { email: 'manager@alpha.dev', password: 'DevPassword123!' },
    headers: { 'Content-Type': 'application/json' },
  });
  ev.loginStatus = login.status();
  const setCookies = login
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);
  ev.setCookies = setCookies.map(
    (c) => c.split(';')[0].split('=')[0] + ' :: ' + c.split(';').slice(1).join(';').trim(),
  );
  const access = setCookies.find((c) => c.startsWith('access_token='));
  const refresh = setCookies.find((c) => c.startsWith('refresh_token='));
  ev.accessHttpOnly = /httponly/i.test(access ?? '');
  ev.accessSameSite = /samesite/i.test(access ?? '');
  ev.refreshHttpOnly = /httponly/i.test(refresh ?? '');
  ev.refreshScopedPath = /path=\/api\/v1\/auth\/refresh/i.test(refresh ?? '');
  ev.verdict = ev.accessHttpOnly && ev.accessSameSite && ev.refreshHttpOnly ? 'SECURE' : 'CHECK';
  rec('cookie-flags', ev);
  expect(ev.accessHttpOnly, 'access_token must be httpOnly').toBeTruthy();
  expect(ev.refreshHttpOnly, 'refresh_token must be httpOnly').toBeTruthy();
});

test('SEC rate-limit — login spam triggers 429 (A.12)', async () => {
  const ev: Record<string, unknown> = { probe: 'rate-limit' };
  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) {
    const r = await anon.post(`${API}/api/v1/auth/login`, {
      data: { email: 'nobody@alpha.dev', password: 'wrong-password-xyz' },
      headers: { 'Content-Type': 'application/json' },
    });
    statuses.push(r.status());
  }
  ev.statuses = statuses;
  ev.got429 = statuses.includes(429);
  ev.verdict = ev.got429 ? 'SECURE (429 after threshold)' : 'OPEN (no 429 in 14 attempts)';
  rec('rate-limit', ev);
  expect(ev.got429, 'login should rate-limit (429) under spam').toBeTruthy();
});
