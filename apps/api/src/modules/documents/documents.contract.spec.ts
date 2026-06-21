/**
 * Phase 4 — Documents CONTRACT conformance suite (BLACK-BOX).
 *
 * Spec-derived (docs/03 §8, D.16, D.17, locked `documents` RLS, the
 * user-mandated confidentiality model). Talks HTTP to a live API; skips
 * if unreachable (CI `conformance` boots the compiled API + runs it).
 *
 *  DOC1  Unauthenticated → 401.
 *  DOC2  Manager create → 2xx {data:{document,uploadUrl,...}}; the
 *        document is DocumentSchema-shaped; org from JWT.
 *  DOC3  Invalid / unknown-field / bad mime / oversize → 400.
 *  DOC4  Create under foreign/unknown project → 404 (no oracle).
 *  DOC5  CONFIDENTIALITY: r2Key/r2_key NEVER appears in create/get/list
 *        bodies (only the opaque signed URL on create/download).
 *  DOC6  Get by id; random uuid → 404 not_found.
 *  DOC7  Cross-tenant get → 404 AND download → 404 with NO url minted.
 *  DOC8  Finalize match → 200; mismatch → 409 document_integrity_mismatch
 *        and the doc is then archived (gone from list, get → 404).
 *  DOC9  Download (own) → 200 {data:{url,expiresInSeconds}}.
 *  DOC10 Patch name persists; DELETE → 204 soft-archive (gone from list).
 *  DOC11 Keyset pagination + tampered cursor → 400 invalid_cursor.
 *  DOC12 Envelope: success has data; error has error.code.
 */
import { DocumentSchema } from '@emapp/shared-types';
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
  const gsc = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof gsc === 'function' ? gsc.call(res.headers) : [];
  return { status: res.status, body, raw, cookies };
}

function cookie(set: string[], name: string): string | undefined {
  return set
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.split('=')[1];
}
function uniqueEmail(tag: string): string {
  return `doc_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@contract.test`;
}
const PW = 'TestPassword123456';

async function manager(tag: string): Promise<string> {
  const r = await call('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      org_name: 'DOC Org',
      name: 'DOC User',
      email: uniqueEmail(tag),
      password: PW,
    }),
  });
  const at = cookie(r.cookies, 'access_token');
  if (!at) throw new Error(`signup did not yield access_token: ${r.raw}`);
  return at;
}

const validDoc = (over: Json = {}): Json => ({
  name: 'חוזה.pdf',
  type: 'contract',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  contentHash: 'sha256:abc123',
  ...over,
});

async function createDoc(at: string, body: Json): Promise<Res> {
  return call('/documents', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify(body),
  });
}

/** 0049 — create THEN finalize, so the doc is SERVABLE (download requires
 *  uploaded_at, set by a successful finalize). Mirrors the real
 *  create→upload→finalize lifecycle; a doc that is only created is a "ghost". */
async function createFinalizedDoc(at: string, body: Json = validDoc()): Promise<string> {
  const created = await createDoc(at, body);
  const id = ((created.body['data'] as Json)['document'] as Json)['id'] as string;
  await call(`/documents/${id}/finalize`, {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify({ sizeBytes: body['sizeBytes'], contentHash: body['contentHash'] }),
  });
  return id;
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
    console.warn(`[documents.contract] API not reachable at ${API} — all tests SKIPPED.`);
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

const KEY_RE = /org\/[0-9a-f-]+\/doc\/[0-9a-f-]+/i;

describe('CONTRACT · documents · auth & confidentiality', () => {
  ct('DOC1 unauthenticated list → 401', async () => {
    expect((await call('/documents')).status).toBe(401);
  });

  ct('DOC2/DOC5 create → schema-valid; r2Key NEVER in body', async () => {
    const at = await manager('c');
    const r = await createDoc(at, validDoc());
    expect(r.status, r.raw).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    const data = r.body['data'] as Json;
    const doc = data['document'] as Json;
    expect(DocumentSchema.safeParse(doc).success, `not DocumentSchema: ${r.raw}`).toBe(true);
    expect(doc).not.toHaveProperty('r2Key');
    expect(doc).not.toHaveProperty('r2_key');
    expect(JSON.stringify(doc)).not.toMatch(KEY_RE); // doc object carries no key
    expect(typeof data['uploadUrl']).toBe('string');
    expect(typeof data['uploadExpiresInSeconds']).toBe('number');
    expect((doc as Json)['organizationId']).toBeTruthy();
  });

  ct('DOC3 invalid / unknown / bad mime / oversize → 400', async () => {
    const at = await manager('inv');
    expect((await createDoc(at, validDoc({ name: undefined }))).status).toBe(400);
    expect((await createDoc(at, validDoc({ mimeType: 'image/svg+xml' }))).status).toBe(400);
    expect((await createDoc(at, validDoc({ mimeType: 'text/html' }))).status).toBe(400);
    expect((await createDoc(at, validDoc({ sizeBytes: 999_999_999 }))).status).toBe(400);
    const unk = await createDoc(at, validDoc({ injected: true }));
    expect(unk.status).toBe(400);
    expect((unk.body['error'] as Json)?.['code']).toBe('validation_error');
  });

  ct('DOC4 create under foreign/unknown project → 404 (no oracle)', async () => {
    const at = await manager('fp');
    const unknown = await createDoc(
      at,
      validDoc({ projectId: '00000000-0000-0000-0000-0000000000bb' }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe('CONTRACT · documents · CRUD + finalize + isolation', () => {
  ct('DOC6 get own; random uuid → 404', async () => {
    const at = await manager('rd');
    const created = await createDoc(at, validDoc());
    const id = ((created.body['data'] as Json)['document'] as Json)['id'] as string;
    const one = await call(`/documents/${id}`, { cookie: `access_token=${at}` });
    expect(one.status).toBe(200);
    expect((one.body['data'] as Json as Json)['id']).toBe(id);
    expect(JSON.stringify(one.body)).not.toMatch(KEY_RE);
    const nf = await call('/documents/00000000-0000-0000-0000-0000000000cc', {
      cookie: `access_token=${at}`,
    });
    expect(nf.status).toBe(404);
    expect((nf.body['error'] as Json)?.['code']).toBe('not_found');
  });

  ct('DOC7 cross-tenant get & download → 404, NO url minted', async () => {
    const atA = await manager('iso-a');
    const created = await createDoc(atA, validDoc({ name: 'secret.pdf' }));
    const idA = ((created.body['data'] as Json)['document'] as Json)['id'] as string;
    const atB = await manager('iso-b');
    const g = await call(`/documents/${idA}`, { cookie: `access_token=${atB}` });
    expect(g.status, 'org B saw org A document').toBe(404);
    const d = await call(`/documents/${idA}/download`, { cookie: `access_token=${atB}` });
    expect(d.status).toBe(404);
    expect(d.raw).not.toContain('http'); // no signed URL leaked to a foreigner
  });

  ct('DOC8 finalize match → 200; mismatch → 409 + archived', async () => {
    const at = await manager('fin');
    const c1 = await createDoc(at, validDoc({ sizeBytes: 2048, contentHash: 'h-ok' }));
    const id1 = ((c1.body['data'] as Json)['document'] as Json)['id'] as string;
    const ok = await call(`/documents/${id1}/finalize`, {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ sizeBytes: 2048, contentHash: 'h-ok' }),
    });
    expect(ok.status, ok.raw).toBe(200);

    const c2 = await createDoc(at, validDoc({ sizeBytes: 2048, contentHash: 'h-real' }));
    const id2 = ((c2.body['data'] as Json)['document'] as Json)['id'] as string;
    const bad = await call(`/documents/${id2}/finalize`, {
      method: 'POST',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ sizeBytes: 9, contentHash: 'h-tampered' }),
    });
    expect(bad.status).toBe(409);
    expect((bad.body['error'] as Json)?.['code']).toBe('document_integrity_mismatch');
    // rejected doc is archived → no longer retrievable
    expect((await call(`/documents/${id2}`, { cookie: `access_token=${at}` })).status).toBe(404);
  });

  ct('DOC9 download own → 200 {url,expiresInSeconds}', async () => {
    const at = await manager('dl');
    const id = await createFinalizedDoc(at); // 0049 — download requires finalize
    const d = await call(`/documents/${id}/download`, { cookie: `access_token=${at}` });
    expect(d.status).toBe(200);
    const data = d.body['data'] as Json;
    expect(typeof data['url']).toBe('string');
    expect(typeof data['expiresInSeconds']).toBe('number');
  });

  ct('DOC10 patch name persists; archive removes from list', async () => {
    const at = await manager('upd');
    const created = await createDoc(at, validDoc({ name: 'before.pdf' }));
    const id = ((created.body['data'] as Json)['document'] as Json)['id'] as string;
    const p = await call(`/documents/${id}`, {
      method: 'PATCH',
      cookie: `access_token=${at}`,
      body: JSON.stringify({ name: 'after.pdf' }),
    });
    expect(p.status).toBe(200);
    expect((p.body['data'] as Json)['name']).toBe('after.pdf');
    const del = await call(`/documents/${id}`, { method: 'DELETE', cookie: `access_token=${at}` });
    expect(del.status).toBe(204);
    const list = await call('/documents', { cookie: `access_token=${at}` });
    expect((list.body['data'] as Json[]).some((x) => x['id'] === id)).toBe(false);
    expect(JSON.stringify(list.body)).not.toMatch(KEY_RE);
  });

  ct('DOC11/DOC12 pagination + tampered cursor → 400 invalid_cursor', async () => {
    const at = await manager('pg');
    await createDoc(at, validDoc({ name: 'p1.pdf' }));
    await createDoc(at, validDoc({ name: 'p2.pdf' }));
    const p1 = await call('/documents?limit=1', { cookie: `access_token=${at}` });
    expect(p1.status).toBe(200);
    expect((p1.body['data'] as Json[]).length).toBe(1);
    expect((p1.body['page'] as Json)['has_more']).toBe(true);
    const bad = await call('/documents?cursor=not-valid', { cookie: `access_token=${at}` });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Json)?.['code']).toBe('invalid_cursor');
  });
});

// ── DH3 (V13) — heuristic CLASSIFIER (SUGGEST-ONLY) contract ─────────────────
async function classify(at: string, body: Json): Promise<Res> {
  return call('/documents/classify', {
    method: 'POST',
    cookie: `access_token=${at}`,
    body: JSON.stringify(body),
  });
}

describe('CONTRACT · documents · classify (DH3 suggest-only)', () => {
  ct('DH3-1 unauthenticated classify → 401', async () => {
    const r = await call('/documents/classify', {
      method: 'POST',
      body: JSON.stringify({ filename: 'נסח.pdf', mimeType: 'application/pdf' }),
    });
    expect(r.status).toBe(401);
  });

  ct('DH3-2 filename signal → ranked {data:{suggestions,suggestOnly:true}}', async () => {
    const at = await manager('cls');
    const r = await classify(at, { filename: 'נסח טאבו 123.pdf', mimeType: 'application/pdf' });
    expect(r.status, r.raw).toBe(200);
    const data = r.body['data'] as Json;
    expect(data['suggestOnly']).toBe(true);
    const sugg = data['suggestions'] as Json[];
    expect(Array.isArray(sugg)).toBe(true);
    expect(sugg.length).toBeGreaterThan(0);
    // Top suggestion is land_registry (נסח); shape carries docType+confidence.
    expect((sugg[0] as Json)['docType']).toBe('land_registry');
    expect(typeof (sugg[0] as Json)['confidence']).toBe('number');
    // No raw filename echo anywhere (reason keys are content-free constants).
    expect(JSON.stringify(r.body)).not.toContain('טאבו');
  });

  ct('DH3-3 Zod rejects bad input (missing filename / bad mime / unknown field) → 400', async () => {
    const at = await manager('clsbad');
    expect((await classify(at, { mimeType: 'application/pdf' })).status).toBe(400);
    expect((await classify(at, { filename: 'x.pdf', mimeType: 'image/svg+xml' })).status).toBe(400);
    const unk = await classify(at, { filename: 'x.pdf', mimeType: 'application/pdf', injected: true });
    expect(unk.status).toBe(400);
    expect((unk.body['error'] as Json)?.['code']).toBe('validation_error');
    // Oversized sample (> base64 cap) → 400.
    const huge = 'A'.repeat(20_000);
    expect((await classify(at, { filename: 'x.pdf', mimeType: 'application/pdf', sampleBase64: huge })).status).toBe(400);
  });

  ct('DH3-4 SUGGEST-ONLY: classify creates NO document (list count unchanged)', async () => {
    const at = await manager('clsnowrite');
    const before = await call('/documents', { cookie: `access_token=${at}` });
    const beforeCount = (before.body['data'] as Json[]).length;
    // A classify with a PDF magic-byte sample (base64 of "%PDF-1.4").
    const sample = Buffer.from('%PDF-1.4\nhello', 'latin1').toString('base64');
    const r = await classify(at, { filename: 'הסכם.pdf', mimeType: 'application/pdf', sampleBase64: sample });
    expect(r.status).toBe(200);
    const after = await call('/documents', { cookie: `access_token=${at}` });
    expect((after.body['data'] as Json[]).length).toBe(beforeCount);
  });

  ct('DH3-5 unknown-signal filename → empty suggestions (FE leaves type unset)', async () => {
    const at = await manager('clsempty');
    // .png with a generic name + no marker → no filename/content signal; the
    // weak image mime prior yields at most an "other" low-confidence hint, so
    // assert the shape is valid and never asserts a strong type.
    const r = await classify(at, { filename: 'random-scan-001.png', mimeType: 'image/png' });
    expect(r.status).toBe(200);
    const sugg = (r.body['data'] as Json)['suggestions'] as Json[];
    // No HIGH-confidence false positive.
    for (const s of sugg) expect((s as Json)['confidence'] as number).toBeLessThan(0.5);
  });
});

afterAll(() => {
  if (!LIVE) return;
  // eslint-disable-next-line no-console
  console.warn('[documents.contract] ran against ' + API);
});
