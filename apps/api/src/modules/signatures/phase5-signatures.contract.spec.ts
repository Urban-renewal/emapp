/**
 * Phase 5 — Signatures CONTRACT E2E (BLACK-BOX, fresh-eyes auditor).
 *
 * Premise: a security auditor who knows the spec (docs/03 §9, D.12, D.16,
 * D.22 F, D.29) but has NEVER read the implementation. They have access
 * to the same env the production service has — including
 * SIGNATURE_TOKEN_SECRET — so they can FORGE tokens to test boundary
 * conditions (this is the standard "credentialed audit" posture; an
 * external attacker WITHOUT the secret is even more constrained, so a
 * credentialed-audit pass is the higher bar).
 *
 * The 10 security layers we documented end-to-end, each pinned by ≥1
 * assertion below. Numbering matches the design doc.
 *
 *  E1   Happy create  — manager creates → 200; signUrl is JWT-shaped
 *  E2   Happy preview — GET /sign/:token → 200; document name + owner name
 *  E3   Happy sign    — POST /sign/:token → 200 signedAt
 *  E4   Single-use    — same token POST twice → 2nd is 401 invalid_token (layer 2)
 *  E5   Tamper        — flip a byte of a fresh token → 401 (layer 1)
 *  E6   Wrong secret  — forge with JWT_SECRET → 401 (layer 1)
 *  E7   Wrong audience— forge with aud=emapp-api → 401 (layer 1)
 *  E8   Cross-org IDOR — manager-A creates; manager-B tries the same token (no, the token is for org-A); a token forged claiming Org A but pointing to a doc in Org B → 401 (layer 6)
 *  E9   Invalid SVG   — POST with non-svg body → 400 validation_error (layer 4)
 *  E10  Expired token — exp in the past → 401 (layer 1)
 *  E11  No-oracle     — every failure mode returns SAME generic invalid_token
 *  E12  Token-in-response — no failure response leaks the token verbatim (layer 5 lower bound)
 *  E13  Auth not required — GET/POST /sign/:token works WITHOUT any access_token cookie (otherwise the link couldn't work)
 *
 * Rate limit and idempotency are NOT exercised here — they belong to
 * generic-cross-cutting tests (throttler.guard.spec, idempotency
 * interceptor). What this spec OWNS is the 10 spec-mandated security
 * layers of the signing flow.
 */
import { serverEnv } from '@emapp/config';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Use a bare JwtService to mint forged tokens with arbitrary secrets /
// audiences (credentialed-audit posture). The library is already in
// the dep tree via @nestjs/jwt.
const jwt = new JwtService({});

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
  const gsc = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof gsc === 'function' ? gsc.call(res.headers) : [];
  return { status: res.status, body, raw, cookies };
}

function cookieValue(set: string[], name: string): string | undefined {
  return set
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.split('=')[1];
}
function uniqueEmail(tag: string): string {
  return `sig_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@audit.test`;
}
const PW = 'AuditPassword123456';

interface Manager {
  at: string;
  orgId: string;
}

async function signup(tag: string): Promise<Manager> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: `Sig Org ${tag}`,
      name: 'Sig Manager',
      email: uniqueEmail(tag),
      password: PW,
    }),
  });
  const at = cookieValue(r.cookies, 'access_token');
  if (!at) throw new Error(`signup ${tag} → no access_token: ${r.raw}`);
  // Resolve orgId via /me.
  const me = await call('/me', { cookie: `access_token=${at}` });
  const meBody = me.body as { data?: { organization?: { id?: string } } };
  const orgId = meBody.data?.organization?.id;
  if (!orgId) throw new Error(`/me did not yield orgId: ${me.raw}`);
  return { at, orgId };
}

async function createDocument(at: string): Promise<string> {
  const r = await call('/documents', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({
      name: 'תמא38-חוזה.pdf',
      type: 'contract',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      contentHash: 'sha256:phase5-audit-' + Math.random().toString(36).slice(2),
    }),
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`create doc failed ${r.status}: ${r.raw}`);
  }
  const body = r.body as { data?: { document?: { id?: string } } };
  const id = body.data?.document?.id;
  if (!id) throw new Error(`no document.id in response: ${r.raw}`);
  return id;
}

// Israeli ID Luhn mod-10 generator — copied from owners.contract.spec.ts.
function validId(seed: number): string {
  const eight = String(seed % 100000000).padStart(8, '0');
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = Number(eight[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return eight + String(check);
}
let idSeed = 30_000_000 + Math.floor(Math.random() * 50_000_000);
const nextNationalId = (): string => validId(idSeed++);

async function createOwner(at: string): Promise<string> {
  const r = await call('/owners', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({
      name: 'אבי כהן',
      national_id: nextNationalId(),
      phone: '0541112233',
      email: 'avi@audit.test',
    }),
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`create owner failed ${r.status}: ${r.raw}`);
  }
  const body = r.body as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error(`no owner.id: ${r.raw}`);
  return id;
}

async function createSignatureRequest(
  at: string,
  documentId: string,
  ownerId: string,
): Promise<{ token: string; signUrl: string; requestId: string }> {
  const r = await call('/signature-requests', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ documentId, ownerId }),
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`create sig req failed ${r.status}: ${r.raw}`);
  }
  const body = r.body as {
    data?: { signUrl?: string; request?: { id?: string } };
  };
  const signUrl = body.data?.signUrl;
  const requestId = body.data?.request?.id;
  if (!signUrl || !requestId) throw new Error(`bad sig req response: ${r.raw}`);
  // Extract token from URL: ".../sign/<token>"
  const token = signUrl.split('/sign/')[1];
  if (!token) throw new Error(`no token in signUrl: ${signUrl}`);
  return { token, signUrl, requestId };
}

/** Minimal valid SVG signature payload — must match Zod regex /^<svg[\s\S]*<\/svg>$/i */
const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M 10 10 L 50 25 L 90 10" stroke="black" fill="none"/></svg>`;

// Read secrets from the same env the API uses. (Credentialed-audit posture.)
const SIG_SECRET = serverEnv.SIGNATURE_TOKEN_SECRET;
const JWT_SECRET = serverEnv.JWT_SECRET;

interface Fixture {
  orgA: Manager;
  orgB: Manager;
  docAId: string;
  docBId: string;
  ownerAId: string;
  ownerBId: string;
}
let fx: Fixture | undefined;

beforeAll(async () => {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2500) });
    LIVE = res.ok;
  } catch {
    LIVE = false;
  }
  if (!LIVE) {
    // eslint-disable-next-line no-console
    console.warn(`[phase5-signatures] API not reachable at ${API} — all tests SKIPPED.`);
    return;
  }
  if (!SIG_SECRET || !JWT_SECRET) {
    // eslint-disable-next-line no-console
    console.warn(
      '[phase5-signatures] SIGNATURE_TOKEN_SECRET or JWT_SECRET missing — credentialed-audit tests SKIPPED.',
    );
    LIVE = false;
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(`[phase5-signatures] ran against ${API}`);

  // Provision fixtures.
  const orgA = await signup('orgA');
  const orgB = await signup('orgB');
  const [docAId, ownerAId, docBId, ownerBId] = await Promise.all([
    createDocument(orgA.at),
    createOwner(orgA.at),
    createDocument(orgB.at),
    createOwner(orgB.at),
  ]);
  fx = { orgA, orgB, docAId, docBId, ownerAId, ownerBId };
});

afterAll(() => {
  // No teardown — contract suite leaves fixtures (consistent with other
  // suites in this repo).
});

function ct(name: string, fn: () => Promise<void>): void {
  // 30s per test — each one creates fresh documents+owners+signature
  // requests over real HTTP to Neon dev (~250-500ms per round-trip).
  // CI runs against local Postgres (fast); this generous budget is for
  // the dev-Neon environment.
  it(
    name,
    async () => {
      if (!LIVE) return;
      await fn();
    },
    30000,
  );
}

describe('Phase 5 · Signatures · public-link signing — E2E security audit', () => {
  // ─── E1: happy create ─────────────────────────────────────────────
  ct('E1 manager creates signature request → 200; signUrl is JWT-shaped', async () => {
    expect(fx).toBeDefined();
    const r = await call('/signature-requests', {
      method: 'POST',
      cookie: `access_token=${fx!.orgA.at}`,
      body: JSON.stringify({ documentId: fx!.docAId, ownerId: fx!.ownerAId }),
    });
    expect([200, 201]).toContain(r.status);
    const body = r.body as {
      data?: { signUrl?: string; request?: { status?: string }; delivery?: unknown };
    };
    expect(body.data?.request?.status).toBe('pending');
    expect(body.data?.signUrl).toMatch(/\/sign\/[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(body.data?.delivery).toBeDefined(); // shape exists even if all channels deferred
  });

  // ─── E2 + E3: happy preview + sign (single use scenario; E4 reuses it) ─
  ct('E2 + E3 + E4 happy flow then single-use guard fires on 2nd POST', async () => {
    // Create a fresh request (E1 above consumed one). We'll cancel its
    // pending via signing it.
    // ACTUALLY — we already used (docA, ownerA) in E1 with status=pending.
    // We need a different (doc, owner) for this test to avoid the 409
    // signature_request_pending_exists guard. Make a 2nd doc + owner.
    const doc2 = await createDocument(fx!.orgA.at);
    const owner2 = await createOwner(fx!.orgA.at);
    const { token } = await createSignatureRequest(fx!.orgA.at, doc2, owner2);

    // E2: preview (no cookie — public).
    const preview = await call(`/sign/${token}`);
    expect(preview.status).toBe(200);
    const pBody = preview.body as {
      data?: {
        document?: { name?: string; downloadUrl?: string };
        owner?: { name?: string };
        expiresAt?: string;
      };
    };
    expect(pBody.data?.document?.name).toBeTruthy();
    expect(pBody.data?.document?.downloadUrl).toMatch(/^https?:\/\//);
    expect(pBody.data?.owner?.name).toBeTruthy();
    expect(pBody.data?.expiresAt).toBeTruthy();

    // E3: sign (no cookie — public).
    const sign1 = await call(`/sign/${token}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(sign1.status).toBe(200);
    const sBody = sign1.body as { data?: { signedAt?: string } };
    expect(sBody.data?.signedAt).toBeTruthy();

    // E4: same token, second sign → atomic single-use guard fires.
    const sign2 = await call(`/sign/${token}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(sign2.status).toBe(401);
    const s2Body = sign2.body as { error?: { code?: string } };
    expect(s2Body.error?.code).toBe('invalid_token');
  });

  // ─── E5: tamper ──────────────────────────────────────────────────
  ct('E5 tampered token (byte flip in payload segment) → 401', async () => {
    const doc = await createDocument(fx!.orgA.at);
    const owner = await createOwner(fx!.orgA.at);
    const { token } = await createSignatureRequest(fx!.orgA.at, doc, owner);
    const parts = token.split('.');
    const flipped = parts[1]!.slice(0, -1) + (parts[1]!.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = [parts[0], flipped, parts[2]].join('.');

    const r = await call(`/sign/${tampered}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(r.status).toBe(401);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('invalid_token');
  });

  // ─── E6: wrong secret ────────────────────────────────────────────
  ct('E6 token signed with JWT_SECRET (not SIGNATURE_TOKEN_SECRET) → 401', async () => {
    // Forge a token signed with the org/access JWT_SECRET — different
    // blast radius is the entire point of the separation in docs/03 §9.
    const forged = jwt.sign(
      {
        sub: '00000000-0000-0000-0000-000000000000',
        orgId: fx!.orgA.orgId,
        documentId: fx!.docAId,
        ownerId: fx!.ownerAId,
      },
      {
        secret: JWT_SECRET!,
        algorithm: 'HS256',
        issuer: 'emapp',
        audience: 'emapp-sign', // even with the right audience, wrong secret → reject
        expiresIn: '7d',
        jwtid: '11111111-1111-1111-1111-111111111111',
      },
    );
    const r = await call(`/sign/${forged}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(r.status).toBe(401);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('invalid_token');
  });

  // ─── E7: wrong audience ──────────────────────────────────────────
  ct('E7 token with audience=emapp-api (D.29 org tier) → 401', async () => {
    const forged = jwt.sign(
      {
        sub: '00000000-0000-0000-0000-000000000000',
        orgId: fx!.orgA.orgId,
        documentId: fx!.docAId,
        ownerId: fx!.ownerAId,
      },
      {
        secret: SIG_SECRET!,
        algorithm: 'HS256',
        issuer: 'emapp',
        audience: 'emapp-api', // backdoor candidate — must be rejected
        expiresIn: '7d',
        jwtid: '22222222-2222-2222-2222-222222222222',
      },
    );
    const r = await call(`/sign/${forged}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(r.status).toBe(401);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('invalid_token');
  });

  // ─── E8: cross-org IDOR via token forgery ────────────────────────
  ct('E8 token claiming Org A but pointing to Org B`s doc → 401 (RLS)', async () => {
    // The attacker has the secret and crafts a syntactically valid token
    // claiming orgA but referencing a document that exists in orgB.
    // RLS scoping in withTenant(orgA.orgId) should make orgB's doc
    // invisible — the service can't find a matching signature_requests
    // row (none was created) and returns generic 401.
    const forged = jwt.sign(
      {
        sub: '33333333-3333-3333-3333-333333333333',
        orgId: fx!.orgA.orgId,
        documentId: fx!.docBId, // Org B's doc!
        ownerId: fx!.ownerBId,
      },
      {
        secret: SIG_SECRET!,
        algorithm: 'HS256',
        issuer: 'emapp',
        audience: 'emapp-sign',
        expiresIn: '7d',
        jwtid: '33333333-3333-3333-3333-333333333333',
      },
    );
    const r = await call(`/sign/${forged}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(r.status).toBe(401);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('invalid_token');
  });

  // ─── E9: invalid SVG payload ─────────────────────────────────────
  ct('E9 invalid SVG (not <svg>...) → 400 validation_error', async () => {
    const doc = await createDocument(fx!.orgA.at);
    const owner = await createOwner(fx!.orgA.at);
    const { token } = await createSignatureRequest(fx!.orgA.at, doc, owner);

    const r = await call(`/sign/${token}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: 'not-an-svg-at-all' }),
    });
    expect(r.status).toBe(400);
    expect((r.body as { error?: { code?: string } }).error?.code).toMatch(
      /^(validation_error|invalid_input)$/,
    );
  });

  // ─── E10: expired token ──────────────────────────────────────────
  ct('E10 expired token → 401', async () => {
    const forged = jwt.sign(
      {
        sub: '44444444-4444-4444-4444-444444444444',
        orgId: fx!.orgA.orgId,
        documentId: fx!.docAId,
        ownerId: fx!.ownerAId,
      },
      {
        secret: SIG_SECRET!,
        algorithm: 'HS256',
        issuer: 'emapp',
        audience: 'emapp-sign',
        expiresIn: '-1s',
        notBefore: -10,
        jwtid: '44444444-4444-4444-4444-444444444444',
      },
    );
    const r = await call(`/sign/${forged}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(r.status).toBe(401);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('invalid_token');
  });

  // ─── E11: no-oracle (same surface for ALL failure modes) ─────────
  ct('E11 NO-ORACLE — every failure mode returns IDENTICAL surface', async () => {
    const doc = await createDocument(fx!.orgA.at);
    const owner = await createOwner(fx!.orgA.at);
    const { token } = await createSignatureRequest(fx!.orgA.at, doc, owner);

    // Snapshot the response for a tampered token.
    const parts = token.split('.');
    const flipped = parts[1]!.slice(0, -1) + (parts[1]!.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = [parts[0], flipped, parts[2]].join('.');

    const expired = jwt.sign(
      {
        sub: '55555555-5555-5555-5555-555555555555',
        orgId: fx!.orgA.orgId,
        documentId: fx!.docAId,
        ownerId: fx!.ownerAId,
      },
      {
        secret: SIG_SECRET!,
        algorithm: 'HS256',
        issuer: 'emapp',
        audience: 'emapp-sign',
        expiresIn: '-1s',
        notBefore: -10,
        jwtid: '55555555-5555-5555-5555-555555555555',
      },
    );

    const responses = await Promise.all([
      call(`/sign/${tampered}`, {
        method: 'POST',
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      }),
      call(`/sign/${expired}`, {
        method: 'POST',
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      }),
      call(`/sign/this.is.notajwt`, {
        method: 'POST',
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      }),
    ]);

    for (const r of responses) {
      expect(r.status).toBe(401);
      expect((r.body as { error?: { code?: string } }).error?.code).toBe('invalid_token');
      // The body must NOT contain anything that distinguishes WHY it failed.
      const keys = Object.keys((r.body as { error?: Json }).error ?? {});
      expect(keys.sort()).toEqual(['code']);
    }
  });

  // ─── E12: token NEVER in any failure response body ───────────────
  ct('E12 token never leaks into response bodies (layer 5 lower bound)', async () => {
    const doc = await createDocument(fx!.orgA.at);
    const owner = await createOwner(fx!.orgA.at);
    const { token } = await createSignatureRequest(fx!.orgA.at, doc, owner);

    // Use the token once successfully — then second call → 401 — verify
    // the 401 body does NOT contain the token (even partially).
    await call(`/sign/${token}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    const r2 = await call(`/sign/${token}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(r2.status).toBe(401);
    expect(r2.raw).not.toContain(token);
    // Even partial leak (first 20 chars) → fail.
    expect(r2.raw).not.toContain(token.slice(0, 20));
  });

  // ─── E13: no auth required (the JWT IS the credential) ──────────
  ct('E13 GET + POST /sign/:token work WITHOUT any access cookie', async () => {
    const doc = await createDocument(fx!.orgA.at);
    const owner = await createOwner(fx!.orgA.at);
    const { token } = await createSignatureRequest(fx!.orgA.at, doc, owner);

    // Deliberately NO cookie. This is the public-link flow's defining
    // property — a resident clicking from WhatsApp has no session.
    const preview = await call(`/sign/${token}`);
    expect(preview.status).toBe(200);

    const sign = await call(`/sign/${token}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(sign.status).toBe(200);
  });
});
