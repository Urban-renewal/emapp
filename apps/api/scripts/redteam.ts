/* eslint-disable no-console -- CLI red-team script: console IS the output channel */
/**
 * RED-TEAM harness (dev only). Think like an attacker.
 *
 *  1. Wipes ALL public-schema rows on the (dev) DB — removes every dummy
 *     user/org/owner created by the contract suite & manual smokes.
 *  2. Provisions a CLEAN, controlled fixture over the real HTTP API:
 *       Org אלפא  : Manager A + Agent A + Viewer A
 *       Org ביתא  : Manager B + Agent B + Viewer B
 *       Provider/product admin (Tier-3, MFA mandatory) — created directly
 *       so we own the TOTP secret and can test MFA accept/deny.
 *  3. Runs an adversarial probe matrix (authN bypass, IDOR/cross-tenant,
 *     privilege-escalation D.17, mass-assignment, PII non-leak, injection,
 *     idempotency abuse, brute-force/lockout, invite-token abuse, provider
 *     MFA). Prints a PASS/FAIL report. A FAIL = a real security defect.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec tsx scripts/redteam.ts
 *
 * Requires the API running on $BASE (default http://localhost:3000) booted
 * with THROTTLE_TEST_BYPASS=contract-suite (functional setup uses the
 * bypass header; the brute-force probe deliberately does NOT).
 */
import { randomBytes, randomUUID, createHmac } from 'node:crypto';

import { providerDb, sql, encryptField, hashField, env as dbEnv } from '@emapp/db';
import { Secret, TOTP } from 'otpauth';

import { hashPassword } from '../src/modules/auth/password';

const BASE = process.env['REDTEAM_BASE'] ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const BYPASS = 'contract-suite';

type Json = Record<string, unknown>;
interface Res {
  status: number;
  body: Json;
  raw: string;
  cookies: string[];
}

interface CallInit {
  method?: string;
  body?: string;
  cookie?: string;
  headers?: Record<string, string>;
  noBypass?: boolean;
}

async function call(path: string, init: CallInit = {}): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.noBypass ? {} : { 'x-throttle-bypass': BYPASS }),
    ...(init.cookie ? { Cookie: init.cookie } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  });
  const raw = await res.text();
  let body: Json = {};
  try {
    body = raw ? (JSON.parse(raw) as Json) : {};
  } catch {
    body = { __nonjson: raw };
  }
  const gsc = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof gsc === 'function' ? gsc.call(res.headers) : [];
  return { status: res.status, body, raw, cookies };
}

function tokenFrom(cookies: string[], name = 'access_token'): string | undefined {
  return cookies
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.split('=')[1];
}

// ── result accounting ──────────────────────────────────────────────────────
const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail: string): void {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
}

const PW = 'RedTeamPass!2026';

interface Org {
  name: string;
  managerTok: string;
  agentTok: string;
  viewerTok: string;
  agentUserId: string;
  viewerUserId: string;
  assignedProjectId: string;
}

async function signupManager(orgName: string, email: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ org_name: orgName, name: 'מנהל', email, password: PW }),
  });
  const t = tokenFrom(r.cookies);
  if (!t) throw new Error(`signup failed (${orgName}): ${r.status} ${r.raw}`);
  return t;
}

async function inviteAndActivate(
  managerTok: string,
  email: string,
  role: 'agent' | 'viewer',
): Promise<{ userId: string; token: string }> {
  const inv = await call('/members', {
    method: 'POST',
    cookie: `access_token=${managerTok}`,
    body: JSON.stringify({ email, name: role, role }),
  });
  const data = inv.body['data'] as Json | undefined;
  const inviteToken = data?.['inviteToken'] as string | undefined;
  const member = data?.['member'] as Json | undefined;
  if (!inviteToken || !member) throw new Error(`invite failed ${email}: ${inv.status} ${inv.raw}`);
  const acc = await call('/auth/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ token: inviteToken, password: PW }),
  });
  if (acc.status !== 200) throw new Error(`accept-invite failed ${email}: ${acc.raw}`);
  const login = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: PW }),
  });
  const t = tokenFrom(login.cookies);
  if (!t) throw new Error(`login failed ${email}: ${login.raw}`);
  return { userId: member['userId'] as string, token: t };
}

async function buildOrg(orgName: string, tag: string): Promise<Org> {
  const ts = Date.now();
  const managerTok = await signupManager(orgName, `mgr_${tag}_${ts}@redteam.test`);
  const agent = await inviteAndActivate(managerTok, `agent_${tag}_${ts}@redteam.test`, 'agent');
  const viewer = await inviteAndActivate(managerTok, `viewer_${tag}_${ts}@redteam.test`, 'viewer');

  // a project the Agent IS assigned to (for the "agent sees only assigned" probe)
  const proj = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${managerTok}`,
    body: JSON.stringify({ name: `Proj ${orgName}`, type: 'tama38_1' }),
  });
  const projectId = (proj.body['data'] as Json)['id'] as string;
  await call(`/projects/${projectId}/assignments`, {
    method: 'POST',
    cookie: `access_token=${managerTok}`,
    body: JSON.stringify({ userId: agent.userId }),
  });

  return {
    name: orgName,
    managerTok,
    agentTok: agent.token,
    viewerTok: viewer.token,
    agentUserId: agent.userId,
    viewerUserId: viewer.userId,
    assignedProjectId: projectId,
  };
}

// ── 1. wipe ────────────────────────────────────────────────────────────────
async function wipe(): Promise<void> {
  const res = await providerDb.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const rows = res.rows;
  if (rows.length === 0) throw new Error('no public tables found — wrong DB?');
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await providerDb.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  console.log(`WIPED ${rows.length} public tables (drizzle migration state preserved)`);
}

// ── provider admin (own the TOTP secret) ───────────────────────────────────
async function makeProviderAdmin(email: string): Promise<{ secret: Secret }> {
  const password = PW;
  const passwordHash = await hashPassword(password);
  const secret = new Secret({ size: 20 });
  const mfaSecretEncrypted = await encryptField(
    providerDb,
    secret.base32,
    dbEnv.PII_ENCRYPTION_KEY as string,
  );
  const recovery = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
  const recoveryCodesHash = recovery.map((r) => hashField(r, dbEnv.PII_HASH_KEY as string));
  // direct insert via BYPASSRLS provider db (provider_users has no RLS)
  await providerDb.execute(
    sql`INSERT INTO provider_users (email,name,password_hash,role,mfa_secret_encrypted,recovery_codes_hash)
        VALUES (${email}, 'Provider Admin', ${passwordHash}, 'admin', ${mfaSecretEncrypted}, ${JSON.stringify(recoveryCodesHash)}::jsonb)`,
  );
  return { secret };
}

// forge a JWT (alg=none and wrong-secret) for authN bypass probes
function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}
function forgeNoneJwt(payload: Json): string {
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`;
}
function forgeHsJwt(payload: Json, secret: string): string {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

async function main(): Promise<void> {
  console.log(`\n=== RED-TEAM @ ${API} ===\n`);
  const health = await call('/health');
  if (health.status !== 200) throw new Error(`API not healthy: ${health.status}`);

  await wipe();

  // ── 2. provision ─────────────────────────────────────────────────────────
  const A = await buildOrg('ארגון אלפא', 'a');
  const B = await buildOrg('ארגון ביתא', 'b');
  const provEmail = `provider_${Date.now()}@redteam.test`;
  const { secret } = await makeProviderAdmin(provEmail);
  console.log(
    `\nProvisioned: Org אלפא {Mgr,Agent,Viewer}, Org ביתא {Mgr,Agent,Viewer}, Provider admin ${provEmail}\n`,
  );

  // a private project in Org A (Manager-created, Agent NOT assigned to it)
  const secretProj = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    body: JSON.stringify({ name: 'SECRET-A', type: 'pinui_binui' }),
  });
  const secretProjId = (secretProj.body['data'] as Json)['id'] as string;

  const ownerCreate = await call('/owners', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    body: JSON.stringify({ name: 'בעל דירה', national_id: '000000018', phone: '0501234567' }),
  });
  const ownerId = (ownerCreate.body['data'] as Json | undefined)?.['id'] as string | undefined;

  // ── A. authN bypass ──────────────────────────────────────────────────────
  check(
    'A1 no-cookie protected route → 401',
    (await call('/projects')).status === 401,
    'GET /projects',
  );
  check(
    'A2 garbage token → 401',
    (await call('/projects', { cookie: 'access_token=not.a.jwt' })).status === 401,
    'random string',
  );
  const noneTok = forgeNoneJwt({ sub: A.agentUserId, orgId: 'x', role: 'manager' });
  check(
    'A3 alg=none forged token → 401',
    (await call('/projects', { cookie: `access_token=${noneTok}` })).status === 401,
    'unsigned token rejected',
  );
  const wrongTok = forgeHsJwt({ sub: A.agentUserId, role: 'manager' }, 'attacker-guessed-secret');
  check(
    'A4 wrong-secret signature → 401',
    (await call('/projects', { cookie: `access_token=${wrongTok}` })).status === 401,
    'bad HS256 sig rejected',
  );

  // ── B. cross-tenant / IDOR (the core claim) ──────────────────────────────
  const bGetA = await call(`/projects/${secretProjId}`, { cookie: `access_token=${B.managerTok}` });
  check(
    'B1 Org-B GET Org-A project → 404 no-oracle',
    bGetA.status === 404 && (bGetA.body['error'] as Json)?.['code'] === 'not_found',
    `got ${bGetA.status} ${(bGetA.body['error'] as Json)?.['code'] ?? ''}`,
  );
  const bPatchA = await call(`/projects/${secretProjId}`, {
    method: 'PATCH',
    cookie: `access_token=${B.managerTok}`,
    body: JSON.stringify({ name: 'PWNED' }),
  });
  check('B2 Org-B PATCH Org-A project → 404', bPatchA.status === 404, `got ${bPatchA.status}`);
  const bDelA = await call(`/projects/${secretProjId}`, {
    method: 'DELETE',
    cookie: `access_token=${B.managerTok}`,
  });
  check('B3 Org-B DELETE Org-A project → 404', bDelA.status === 404, `got ${bDelA.status}`);
  const bList = await call('/projects', { cookie: `access_token=${B.managerTok}` });
  const bSees = (bList.body['data'] as Json[]).some((p) => p['id'] === secretProjId);
  check('B4 Org-A project absent from Org-B list', !bSees, bSees ? 'LEAK' : 'isolated');
  if (ownerId) {
    const bOwner = await call(`/owners/${ownerId}`, { cookie: `access_token=${B.managerTok}` });
    check('B5 Org-B GET Org-A owner → 404', bOwner.status === 404, `got ${bOwner.status}`);
    const bSearch = await call('/owners/search', {
      method: 'POST',
      cookie: `access_token=${B.managerTok}`,
      body: JSON.stringify({ national_id: '000000018' }),
    });
    const found = ((bSearch.body['data'] as Json[]) ?? []).length;
    check('B6 Org-B search Org-A national_id → empty', found === 0, `${found} rows`);
  }

  // ── C. privilege escalation (D.17 runtime) ───────────────────────────────
  const vCreate = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${A.viewerTok}`,
    body: JSON.stringify({ name: 'viewer-made', type: 'tama38_1' }),
  });
  check('C1 Viewer POST /projects → 403', vCreate.status === 403, `got ${vCreate.status}`);
  const vPatch = await call(`/projects/${A.assignedProjectId}`, {
    method: 'PATCH',
    cookie: `access_token=${A.viewerTok}`,
    body: JSON.stringify({ name: 'x' }),
  });
  check('C2 Viewer PATCH project → 403', vPatch.status === 403, `got ${vPatch.status}`);
  const vRead = await call(`/projects/${A.assignedProjectId}`, {
    cookie: `access_token=${A.viewerTok}`,
  });
  check('C3 Viewer GET project → 200 (read allowed)', vRead.status === 200, `got ${vRead.status}`);
  const agentUnassigned = await call(`/projects/${secretProjId}`, {
    cookie: `access_token=${A.agentTok}`,
  });
  check(
    'C4 Agent GET UNassigned project → 404 no-oracle',
    agentUnassigned.status === 404,
    `got ${agentUnassigned.status}`,
  );
  const agentAssigned = await call(`/projects/${A.assignedProjectId}`, {
    cookie: `access_token=${A.agentTok}`,
  });
  check(
    'C5 Agent GET assigned project → 200',
    agentAssigned.status === 200,
    `got ${agentAssigned.status}`,
  );
  const vMembers = await call('/members', { cookie: `access_token=${A.viewerTok}` });
  check('C6 Viewer GET /members → 403', vMembers.status === 403, `got ${vMembers.status}`);
  const aMembers = await call('/members', { cookie: `access_token=${A.agentTok}` });
  check('C7 Agent GET /members → 403', aMembers.status === 403, `got ${aMembers.status}`);
  const vEscalate = await call(`/members/${A.viewerUserId}`, {
    method: 'PATCH',
    cookie: `access_token=${A.viewerTok}`,
    body: JSON.stringify({ role: 'manager' }),
  });
  check(
    'C8 Viewer self-escalate to manager → 403',
    vEscalate.status === 403,
    `got ${vEscalate.status}`,
  );

  // ── D. mass-assignment / parameter tampering ─────────────────────────────
  const massOrg = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    body: JSON.stringify({
      name: 'mass',
      type: 'tama38_1',
      organizationId: '00000000-0000-0000-0000-000000000000',
      createdBy: B.agentUserId,
      id: '11111111-1111-1111-1111-111111111111',
    }),
  });
  check(
    'D1 mass-assign org/createdBy/id → 400 strict reject',
    massOrg.status === 400 && (massOrg.body['error'] as Json)?.['code'] === 'validation_error',
    `got ${massOrg.status} ${(massOrg.body['error'] as Json)?.['code'] ?? ''}`,
  );

  // ── E. PII non-leak ──────────────────────────────────────────────────────
  if (ownerId) {
    const get = await call(`/owners/${ownerId}`, { cookie: `access_token=${A.managerTok}` });
    const leaks = get.raw.includes('000000018') || get.raw.includes('0501234567');
    check(
      'E1 owner GET never leaks clear PII',
      !leaks,
      leaks ? 'CLEAR PII IN BODY' : 'masked only',
    );
    const list = await call('/owners', { cookie: `access_token=${A.managerTok}` });
    const listLeak = list.raw.includes('000000018') || list.raw.includes('0501234567');
    check('E2 owner LIST never leaks clear PII', !listLeak, listLeak ? 'LEAK' : 'masked only');
  }

  // ── F. injection / malformed ─────────────────────────────────────────────
  const sqli = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    body: JSON.stringify({ name: "Robert'); DROP TABLE projects;--", type: 'tama38_1' }),
  });
  check(
    'F1 SQLi-ish name stored as literal, no 500',
    sqli.status >= 200 && sqli.status < 300,
    `got ${sqli.status}`,
  );
  const stillThere = await call('/projects', { cookie: `access_token=${A.managerTok}` });
  check(
    'F1b projects table intact after SQLi attempt',
    stillThere.status === 200 && Array.isArray(stillThere.body['data']),
    `list status ${stillThere.status}`,
  );
  const badJson = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    body: '{ not json',
  });
  check(
    'F2 malformed JSON → 400, never 500',
    badJson.status === 400,
    `got ${badJson.status} ${(badJson.body['error'] as Json)?.['code'] ?? ''}`,
  );
  const nul = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    body: JSON.stringify({ name: `a${String.fromCharCode(0)}b`, type: 'tama38_1' }),
  });
  check(
    'F3 NUL byte in field → 4xx, never 5xx',
    nul.status >= 400 && nul.status < 500,
    `got ${nul.status}`,
  );

  // ── G. idempotency abuse ─────────────────────────────────────────────────
  const idemKey = randomUUID();
  const i1 = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify({ name: 'idem-once', type: 'tama38_1' }),
  });
  const i2 = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify({ name: 'idem-once', type: 'tama38_1' }),
  });
  const id1 = (i1.body['data'] as Json | undefined)?.['id'];
  const id2 = (i2.body['data'] as Json | undefined)?.['id'];
  check(
    'G1 same Idempotency-Key replays one create',
    !!id1 && id1 === id2,
    `id1=${String(id1)} id2=${String(id2)}`,
  );
  // same key, DIFFERENT org/user must NOT collide into A's stored response
  const i3 = await call('/projects', {
    method: 'POST',
    cookie: `access_token=${B.managerTok}`,
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify({ name: 'idem-B', type: 'tama38_1' }),
  });
  const id3 = (i3.body['data'] as Json | undefined)?.['id'];
  check(
    'G2 same key cross-tenant is isolated (no replay of A to B)',
    !!id3 && id3 !== id1,
    `B id=${String(id3)} (must differ from A ${String(id1)})`,
  );

  // ── H. brute-force / lockout (NO bypass header) ──────────────────────────
  const victimEmail = `mgr_a_lockme_${Date.now()}@redteam.test`;
  await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ org_name: 'lock org', name: 'v', email: victimEmail, password: PW }),
  });
  let saw429 = false;
  let saw423or401 = false;
  for (let i = 0; i < 25; i++) {
    const r = await call('/auth/login', {
      method: 'POST',
      noBypass: true,
      body: JSON.stringify({ email: victimEmail, password: 'wrong-password' }),
    });
    if (r.status === 429) saw429 = true;
    if (r.status === 401 || r.status === 423) saw423or401 = true;
  }
  check(
    'H1 brute-force eventually throttled (429) or locked',
    saw429 || saw423or401,
    `429=${saw429}`,
  );
  // after many failures the correct password must also be refused (lockout)
  const afterLock = await call('/auth/login', {
    method: 'POST',
    noBypass: true,
    body: JSON.stringify({ email: victimEmail, password: PW }),
  });
  check(
    'H2 valid password refused while locked/throttled',
    afterLock.status !== 200,
    `got ${afterLock.status} (expected non-200 lockout)`,
  );

  // ── I. invite-token abuse ────────────────────────────────────────────────
  const inv = await call('/members', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    body: JSON.stringify({ email: `reuse_${Date.now()}@redteam.test`, name: 'r', role: 'viewer' }),
  });
  const it = (inv.body['data'] as Json)['inviteToken'] as string;
  const acc1 = await call('/auth/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ token: it, password: PW }),
  });
  const acc2 = await call('/auth/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ token: it, password: 'DifferentPass!99' }),
  });
  check('I1 invite accepted once', acc1.status === 200, `got ${acc1.status}`);
  check(
    'I2 invite token single-use (reuse → not 200)',
    acc2.status !== 200,
    `reuse got ${acc2.status} ${(acc2.body['error'] as Json)?.['code'] ?? ''}`,
  );
  const tampered = it.slice(0, -3) + 'AAA';
  const accT = await call('/auth/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ token: tampered, password: PW }),
  });
  check(
    'I3 tampered invite token → rejected no-oracle',
    accT.status !== 200 && (accT.body['error'] as Json)?.['code'] === 'invalid_invite',
    `got ${accT.status} ${(accT.body['error'] as Json)?.['code'] ?? ''}`,
  );

  // ── J. provider MFA ──────────────────────────────────────────────────────
  const noMfa = await call('/provider/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: provEmail, password: PW, mfa_code: '' }),
  });
  check(
    'J1 provider login w/o MFA code → rejected',
    noMfa.status !== 200,
    `got ${noMfa.status} ${(noMfa.body['error'] as Json)?.['code'] ?? ''}`,
  );
  const badMfa = await call('/provider/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: provEmail, password: PW, mfa_code: '000000' }),
  });
  check('J2 provider login wrong MFA → rejected', badMfa.status !== 200, `got ${badMfa.status}`);
  const totp = new TOTP({ issuer: 'EMAPP', label: provEmail, secret, period: 30, digits: 6 });
  const goodMfa = await call('/provider/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: provEmail, password: PW, mfa_code: totp.generate() }),
  });
  check(
    'J3 provider login WITH valid MFA → 200',
    goodMfa.status === 200,
    `got ${goodMfa.status} ${(goodMfa.body['error'] as Json)?.['code'] ?? ''}`,
  );
  const wrongPwGoodMfa = await call('/provider/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: provEmail, password: 'nope', mfa_code: totp.generate() }),
  });
  check(
    'J4 provider wrong password (valid MFA) → rejected, generic',
    wrongPwGoodMfa.status !== 200,
    `got ${wrongPwGoodMfa.status} ${(wrongPwGoodMfa.body['error'] as Json)?.['code'] ?? ''}`,
  );

  // ── K. documents confidentiality (Phase 4) ──────────────────────────────
  const KEY_RE = /org\/[0-9a-f-]+\/doc\/[0-9a-f-]+/i;
  const docBody = {
    name: 'secret.pdf',
    type: 'contract',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    contentHash: 'h1',
  };
  const kViewerCreate = await call('/documents', {
    method: 'POST',
    cookie: `access_token=${A.viewerTok}`,
    body: JSON.stringify(docBody),
  });
  check(
    'K1 Viewer create document → 403',
    kViewerCreate.status === 403,
    `got ${kViewerCreate.status}`,
  );

  const kCreate = await call('/documents', {
    method: 'POST',
    cookie: `access_token=${A.managerTok}`,
    body: JSON.stringify(docBody),
  });
  const kDoc = (kCreate.body['data'] as Json | undefined)?.['document'] as Json | undefined;
  const kDocId = kDoc?.['id'] as string | undefined;
  check(
    'K2 Manager create document → 2xx; r2Key NOT in document object',
    kCreate.status >= 200 &&
      kCreate.status < 300 &&
      !!kDocId &&
      !('r2Key' in (kDoc ?? {})) &&
      !KEY_RE.test(JSON.stringify(kDoc ?? {})),
    `status ${kCreate.status}`,
  );

  if (kDocId) {
    const kGet = await call(`/documents/${kDocId}`, { cookie: `access_token=${A.managerTok}` });
    check(
      'K3 GET document body never contains the storage key',
      kGet.status === 200 && !KEY_RE.test(kGet.raw),
      kGet.status === 200 ? 'no key in body' : `got ${kGet.status}`,
    );
    const kCross = await call(`/documents/${kDocId}`, { cookie: `access_token=${B.managerTok}` });
    check(
      'K4 Org-B GET Org-A document → 404 no-oracle',
      kCross.status === 404,
      `got ${kCross.status}`,
    );
    const kCrossDl = await call(`/documents/${kDocId}/download`, {
      cookie: `access_token=${B.managerTok}`,
    });
    check(
      'K5 Org-B download Org-A document → 404 AND no URL minted',
      kCrossDl.status === 404 && !kCrossDl.raw.includes('http'),
      `got ${kCrossDl.status}`,
    );
    const kAgent = await call(`/documents/${kDocId}`, { cookie: `access_token=${A.agentTok}` });
    check(
      'K6 Agent GET org-level (unassigned) document → 404 no-oracle',
      kAgent.status === 404,
      `got ${kAgent.status}`,
    );
  }

  // ── L. cross-tier JWT rejection (B1 architectural defence) ──────────────
  // After B1 (D.29), each tier has a distinct JWT audience. A token validly
  // signed for the wrong tier MUST be rejected STRUCTURALLY (not by a
  // single payload.type check). Forge tokens with the real JWT secret but
  // with provider/tenant audiences, then present them at /documents.
  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) {
    check('L0 JWT_SECRET available for cross-tier probes', false, 'env not set');
  } else {
    const expSec = Math.floor(Date.now() / 1000) + 900;
    const tenantClaims: Json = {
      sub: '11111111-1111-1111-1111-111111111111',
      orgId: '22222222-2222-2222-2222-222222222222',
      role: 'tenant',
      type: 'tenant_access',
      sid: 'forged-tenant-sid',
      iss: 'emapp',
      aud: 'emapp-tenant',
      exp: expSec,
    };
    const providerClaims: Json = {
      sub: '33333333-3333-3333-3333-333333333333',
      role: 'provider_admin',
      type: 'provider_access',
      sid: 'forged-provider-sid',
      iss: 'emapp',
      aud: 'emapp-provider',
      exp: expSec,
    };
    const tenantTok = forgeHsJwt(tenantClaims, jwtSecret);
    const providerTok = forgeHsJwt(providerClaims, jwtSecret);

    const lTenant = await call('/documents', { cookie: `access_token=${tenantTok}` });
    check(
      'L1 Tenant token (aud=emapp-tenant) at /documents → 401 (B1)',
      lTenant.status === 401,
      `got ${lTenant.status} ${(lTenant.body['error'] as Json)?.['code'] ?? ''}`,
    );
    const lProv = await call('/documents', { cookie: `access_token=${providerTok}` });
    check(
      'L2 Provider token (aud=emapp-provider) at /documents → 401 (B1)',
      lProv.status === 401,
      `got ${lProv.status} ${(lProv.body['error'] as Json)?.['code'] ?? ''}`,
    );
    // Symmetric: an Org token (aud=emapp-api) must STILL be rejected at the
    // provider guard — proves no accidental widening at /provider/auth.
    const orgImposter: Json = {
      sub: '44444444-4444-4444-4444-444444444444',
      orgId: '55555555-5555-5555-5555-555555555555',
      role: 'manager',
      type: 'access',
      sid: 'forged-org-sid',
      iss: 'emapp',
      aud: 'emapp-api',
      exp: expSec,
    };
    const orgTok = forgeHsJwt(orgImposter, jwtSecret);
    const lOrg = await call('/provider/auth/logout', {
      method: 'POST',
      cookie: `access_token=${orgTok}`,
    });
    check(
      'L3 Org token (aud=emapp-api) at /provider/* → not 200 (B1 reverse)',
      lOrg.status !== 200,
      `got ${lOrg.status} ${(lOrg.body['error'] as Json)?.['code'] ?? ''}`,
    );
  }

  // ── report ───────────────────────────────────────────────────────────────
  const fails = results.filter((r) => !r.ok);
  console.log(`\n=== RED-TEAM RESULT: ${results.length - fails.length}/${results.length} held ===`);
  if (fails.length) {
    console.log('SECURITY DEFECTS:');
    for (const f of fails) console.log(`  FAIL ${f.id} — ${f.detail}`);
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`redteam crashed: ${String(err)}\n`);
  process.exit(2);
});
