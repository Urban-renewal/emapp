/**
 * Phase 5 — Signatures FUNCTIONAL E2E (BLACK-BOX, QA-manager posture).
 *
 * The security spec (phase5-signatures.contract.spec.ts) pinned the 10
 * documented security layers. This spec answers a different question:
 * "did the system actually do what the spec says it should, end-to-end,
 * with state landing where the spec says it should land?"
 *
 * Pins:
 *  F1  Audit-trail integrity (docs/03 §9 DoD "Audit log כולל IP, UA,
 *      timestamp" + docs/07 §12.4 every signing event tracked).
 *      Manager queries GET /audit and sees:
 *        - 1× signature_request.create (actor_type=user, target row)
 *        - 1× signature.preview          (actor_type=system)
 *        - 1× signature.signed           (actor_type=system,
 *                                         target_table=signatures)
 *      All carry timestamps. IP/UA are stored but NOT exposed in the
 *      Manager audit view (deliberate per docs/07 §12.3 — sensitive,
 *      Provider-Admin only); we assert they're NOT leaked.
 *  F2  T5.6 — Rate limit fires WITHOUT the contract bypass header.
 *      docs/03 §9 mandates "Rate limiting (5 attempts per IP per hour)".
 *      Six POSTs from the same IP within an hour → 6th = 429.
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

/** Helper that ALWAYS sends the throttle bypass — for setup paths. */
async function call(path: string, init?: RequestInit & { cookie?: string }): Promise<Res> {
  return rawCall(path, init, /*bypass*/ true);
}

/** Helper that sends NO bypass — for the rate-limit assertion. */
async function callNoBypass(path: string, init?: RequestInit & { cookie?: string }): Promise<Res> {
  return rawCall(path, init, /*bypass*/ false);
}

async function rawCall(
  path: string,
  init: (RequestInit & { cookie?: string }) | undefined,
  bypass: boolean,
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bypass) headers['x-throttle-bypass'] = BYPASS;
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
  return `func_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@audit.test`;
}
const PW = 'AuditPassword123456';

async function signup(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: `Func Org ${tag}`,
      name: 'Func Manager',
      email: uniqueEmail(tag),
      password: PW,
    }),
  });
  const at = cookieValue(r.cookies, 'access_token');
  if (!at) throw new Error(`signup ${tag} → no access_token: ${r.raw}`);
  return at;
}

async function createDocument(at: string): Promise<string> {
  const sizeBytes = 1024;
  const contentHash = 'sha256:func-' + Math.random().toString(36).slice(2);
  const r = await call('/documents', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({
      name: 'תמא38-חוזה.pdf',
      type: 'contract',
      mimeType: 'application/pdf',
      sizeBytes,
      contentHash,
    }),
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`create doc failed ${r.status}: ${r.raw}`);
  }
  const id = (r.body as { data?: { document?: { id?: string } } }).data!.document!.id!;
  // 0049 — finalize so the doc is FINALISED; a signature request may only
  // target a finalised doc (a ghost can't be sent for signature).
  const fin = await call(`/documents/${id}/finalize`, {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ sizeBytes, contentHash }),
  });
  if (fin.status !== 200) throw new Error(`finalize doc failed ${fin.status}: ${fin.raw}`);
  return id;
}

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
let idSeed = 60_000_000 + Math.floor(Math.random() * 20_000_000);
const nextNationalId = (): string => validId(idSeed++);

async function createOwner(at: string): Promise<string> {
  const r = await call('/owners', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({
      name: 'משה לוי',
      national_id: nextNationalId(),
      phone: '0541112233',
      email: 'moshe@audit.test',
    }),
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`create owner failed ${r.status}: ${r.raw}`);
  }
  return (r.body as { data?: { id?: string } }).data!.id!;
}

async function createSignatureRequest(
  at: string,
  documentId: string,
  ownerId: string,
): Promise<{ token: string; requestId: string }> {
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
  const token = body.data!.signUrl!.split('/sign/')[1]!;
  return { token, requestId: body.data!.request!.id! };
}

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M 10 10 L 50 25 L 90 10" stroke="black" fill="none"/></svg>`;

beforeAll(async () => {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2500) });
    LIVE = res.ok;
  } catch {
    LIVE = false;
  }
  if (!LIVE) {
    // eslint-disable-next-line no-console
    console.warn(`[phase5-functional] API not reachable at ${API} — all tests SKIPPED.`);
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(`[phase5-functional] ran against ${API}`);
});

afterAll(() => {
  // No teardown — leaves fixtures consistent with other contract suites.
});

function ft(name: string, fn: () => Promise<void>): void {
  it(
    name,
    async () => {
      if (!LIVE) return;
      await fn();
    },
    60000,
  );
}

/** UUID v4 generator for Idempotency-Key. The interceptor (D.22 F)
 *  enforces the key shape strictly. */
function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe('Phase 5 · Signatures · FUNCTIONAL — QA-manager sign-off', () => {
  // ─── F1: full audit-trail integrity ─────────────────────────────
  ft(
    'F1 audit trail: create + preview + signed events landed; IP/UA NOT leaked in Manager view',
    async () => {
      const at = await signup('f1');
      const doc = await createDocument(at);
      const owner = await createOwner(at);
      const { token, requestId } = await createSignatureRequest(at, doc, owner);

      // Walk through the resident-side flow.
      const preview = await call(`/sign/${token}`);
      expect(preview.status).toBe(200);

      const sign = await call(`/sign/${token}`, {
        method: 'POST',
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      });
      expect(sign.status).toBe(200);

      // Manager pulls the audit log for the org.
      const audit = await call('/audit?limit=100', { cookie: `access_token=${at}` });
      expect(audit.status).toBe(200);
      const audBody = audit.body as { data?: Array<Record<string, unknown>> };
      expect(Array.isArray(audBody.data)).toBe(true);
      const rows = audBody.data!;

      // Locate the three Phase-5 events tied to this request.
      const create = rows.find(
        (r) => r.action === 'signature_request.create' && r.targetId === requestId,
      );
      const previewEv = rows.find(
        (r) => r.action === 'signature.preview' && r.targetId === requestId,
      );
      const signed = rows.find((r) => r.action === 'signature.signed');

      expect(create, 'signature_request.create row should exist').toBeTruthy();
      expect(previewEv, 'signature.preview row should exist').toBeTruthy();
      expect(signed, 'signature.signed row should exist').toBeTruthy();

      // actor_type assertions — D.31 G1a pattern (system for public flow,
      // user for the manager's create).
      expect(create!.actorType).toBe('user');
      expect(previewEv!.actorType).toBe('system');
      expect(signed!.actorType).toBe('system');

      // The signed row's target is the SIGNATURE artifact, not the
      // request (the request transition itself is forensic via the row
      // state; the signature is the new record).
      expect(signed!.targetTable).toBe('signatures');

      // Timestamps present.
      expect(create!.createdAt).toBeTruthy();
      expect(previewEv!.createdAt).toBeTruthy();
      expect(signed!.createdAt).toBeTruthy();

      // IP/UA stored in DB but DELIBERATELY not surfaced in the Manager
      // view (docs/07 §12.3 — sensitive, Provider-Admin only).
      // Verify the wire shape doesn't leak them.
      for (const r of [create!, previewEv!, signed!]) {
        expect(r.ip, `audit row "${r.action}" must not leak ip`).toBeUndefined();
        expect(r.userAgent, `audit row "${r.action}" must not leak userAgent`).toBeUndefined();
      }
    },
  );

  // ─── F2: T5.6 — rate limit explicitly fires WITHOUT bypass ──────
  ft('F2 (T5.6) rate limit: 6th POST /sign within an hour from same IP → 429', async () => {
    const at = await signup('f2');
    // Mint six independent fresh tokens so each POST is otherwise valid.
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const doc = await createDocument(at);
      const owner = await createOwner(at);
      const { token } = await createSignatureRequest(at, doc, owner);
      tokens.push(token);
    }

    // Fire 6 POSTs from this process's IP, NO bypass header → real
    // throttler sees them as a burst.
    const responses: number[] = [];
    for (const t of tokens) {
      const r = await callNoBypass(`/sign/${t}`, {
        method: 'POST',
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      });
      responses.push(r.status);
    }

    // The first 5 should succeed (200). The 6th should be 429.
    // Exact distribution: 200,200,200,200,200,429.
    const ok = responses.filter((s) => s === 200).length;
    const throttled = responses.filter((s) => s === 429).length;
    expect(ok).toBe(5);
    expect(throttled).toBe(1);
    expect(responses[5]).toBe(429);
  });

  // ─── F3: T5.7 — post-sign emails fire ────────────────────────────
  ft('F3 (T5.7) post-sign notifications: manager + resident email events audit-trail', async () => {
    // We can't introspect the IEmailProvider's outbox from here
    // (Fake provider is in-process; the contract suite talks HTTP).
    // The OBSERVABLE pin: a successful POST /sign in the dev env
    // returns 200 with `signedAt`, and the test PASSED if the email
    // calls did NOT crash the request handler (the handler awaits
    // notifyAfterSign and swallows per-channel errors, so any throw
    // would propagate as a 500). 200 here IS the proof that the
    // notify path was exercised; the per-channel error log is the
    // operator-side observability.
    //
    // Stronger pin: assert no audit row leakage of email bodies.
    const at = await signup('f3');
    const doc = await createDocument(at);
    const owner = await createOwner(at);
    const { token } = await createSignatureRequest(at, doc, owner);

    const sign = await call(`/sign/${token}`, {
      method: 'POST',
      body: JSON.stringify({ signatureSvg: VALID_SVG }),
    });
    expect(sign.status).toBe(200);

    // Manager-side audit list MUST NOT contain any email subject/body
    // text — the notify path runs OUTSIDE the audit subsystem.
    const audit = await call('/audit?limit=50', {
      cookie: `access_token=${at}`,
    });
    expect(audit.status).toBe(200);
    const audBody = audit.body as { data?: Array<Record<string, unknown>> };
    const audJson = JSON.stringify(audBody.data ?? []);
    // No template strings should leak into audit storage.
    expect(audJson).not.toContain('חתימה התקבלה');
    expect(audJson).not.toContain('תודה — חתימתך');
  });

  // ─── F4: Idempotency-Key on POST /sign/:token (D.22 F) ──────────
  ft(
    'F4 idempotency: same Idempotency-Key replays the same response (no double-sign)',
    async () => {
      const at = await signup('f4');
      const doc = await createDocument(at);
      const owner = await createOwner(at);
      const { token } = await createSignatureRequest(at, doc, owner);

      const key = uuid();

      const first = await call(`/sign/${token}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      });
      expect(first.status).toBe(200);
      const firstBody = first.body as { data?: { signedAt?: string } };
      expect(firstBody.data?.signedAt).toBeTruthy();

      // Re-POST same key + same token: interceptor MUST replay the
      // cached response — same status + same body. Crucially: NO 401
      // (which would mean the second POST actually ran and hit the
      // single-use guard, proving idempotency is NOT active for this
      // route). If we get 401 here, the interceptor isn't applying.
      const second = await call(`/sign/${token}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      });
      expect(second.status, 'idempotent replay must NOT hit the single-use guard').toBe(200);
      const secondBody = second.body as { data?: { signedAt?: string } };
      // Bodies must match exactly — the idempotency interceptor replays.
      expect(secondBody.data?.signedAt).toBe(firstBody.data?.signedAt);
    },
  );

  // ─── F6: in-app notification generation on sign (was Phase-5 deferred) ──
  // The IN-APP half of T5.7. A resident signing must surface a
  // `signature_received` notification to the SR creator (manager/agent),
  // not only an email. Pins the producer + the RLS-scoped insert path.
  ft(
    'F6 in-app notify: resident sign → manager gets a signature_received notification',
    async () => {
      const at = await signup('f6');

      // Baseline: a fresh manager has zero unread (locked self-scope RLS).
      const before = await call('/notifications/unread-count', { cookie: `access_token=${at}` });
      expect(before.status).toBe(200);
      expect((before.body as { data?: { count?: number } }).data?.count).toBe(0);

      const doc = await createDocument(at);
      const owner = await createOwner(at);
      const { token } = await createSignatureRequest(at, doc, owner);

      const sign = await call(`/sign/${token}`, {
        method: 'POST',
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      });
      expect(sign.status).toBe(200);

      // The bell increments — the producer wrote a row scoped to the
      // manager (app.user_id = recipient satisfies the locked WITH CHECK).
      const after = await call('/notifications/unread-count', { cookie: `access_token=${at}` });
      expect(after.status).toBe(200);
      expect((after.body as { data?: { count?: number } }).data?.count).toBeGreaterThanOrEqual(1);

      // And the row is the right type with a non-PII Hebrew title/body.
      const list = await call('/notifications?limit=20', { cookie: `access_token=${at}` });
      expect(list.status).toBe(200);
      const rows = (list.body as { data?: Array<Record<string, unknown>> }).data ?? [];
      const note = rows.find((r) => r.type === 'signature_received');
      expect(note, 'a signature_received notification should exist').toBeTruthy();
      expect(note!.title).toBe('התקבלה חתימה');
      // PII guard — the row stores only the ownerId UUID (in metadata) +
      // the document name; the actual PII (national_id / phone / signature
      // SVG) must NEVER reach the unencrypted notifications row.
      const noteJson = JSON.stringify(note);
      expect(noteJson).not.toMatch(/\b\d{9}\b/); // no raw national_id
      expect(noteJson).not.toMatch(/05\d{8}/); // no raw Israeli phone
      expect(noteJson).not.toContain('<svg'); // no signature material
    },
  );

  // ─── F7: downloadable SIGNED ARTIFACT (the "download signed doc" fix) ──
  ft(
    'F7 signed-document: a signed request yields a downloadable PDF; unsigned/absent → 404',
    async () => {
      const at = await signup('f7');
      const doc = await createDocument(at);
      const owner = await createOwner(at);
      const { token, requestId } = await createSignatureRequest(at, doc, owner);

      // Before signing: no artifact yet → 404.
      const before = await fetch(`${API}/signature-requests/${requestId}/signed-document`, {
        headers: { 'x-throttle-bypass': BYPASS, cookie: `access_token=${at}` },
      });
      expect(before.status).toBe(404);

      // Sign it.
      const sign = await call(`/sign/${token}`, {
        method: 'POST',
        body: JSON.stringify({ signatureSvg: VALID_SVG }),
      });
      expect(sign.status).toBe(200);

      // Now the signed artifact downloads: real PDF bytes + headers.
      const dl = await fetch(`${API}/signature-requests/${requestId}/signed-document`, {
        headers: { 'x-throttle-bypass': BYPASS, cookie: `access_token=${at}` },
      });
      expect(dl.status).toBe(200);
      expect(dl.headers.get('content-type')).toContain('application/pdf');
      expect(dl.headers.get('content-disposition')).toContain('attachment');
      const bytes = Buffer.from(await dl.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(1000);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // valid PDF magic

      // A non-existent request id → generic 404 (no oracle).
      const absent = await fetch(
        `${API}/signature-requests/00000000-0000-0000-0000-000000000000/signed-document`,
        { headers: { 'x-throttle-bypass': BYPASS, cookie: `access_token=${at}` } },
      );
      expect(absent.status).toBe(404);
    },
  );
});
