/**
 * 7d FE — sensitive-document CONTENT path seam tests.
 *
 * BE contract (doc-encryption 7d, documents.service.ts + controller):
 *  - POST /documents for a SENSITIVE doc (id_document/financial, or
 *    sensitive:true) answers `uploadUrl: null` + `contentUploadPath:
 *    "/api/v1/documents/<id>/content"` — NO presigned PUT.
 *  - The client POSTs the raw bytes to that path as
 *    `application/octet-stream` WITH same-origin credentials (the route is
 *    auth-guarded; the path carries no secret).
 *  - On 200 the content route has ALREADY stamped the row uploaded
 *    (integrity-checked, AV-scanned, envelope-encrypted) — the client must
 *    NOT call finalize (it would 409 `document_already_uploaded`).
 *  - Plain docs keep the pre-7d create → presigned PUT → finalize flow
 *    byte-for-byte unchanged.
 *
 * These pin the PURE branch decision (`resolveUploadPlan`), the wire shape
 * of `uploadDocumentContent`, the full `uploadDocumentFlow` orchestration
 * (both legs, mocked fetch), and the dual-mode `fetchDownload` byte branch.
 * Repo convention: pure-logic specs only (no RTL) — the rendered flow is
 * covered by the Playwright e2e (j3b-documents-sensitive-upload.spec.ts).
 */
import { DOCUMENT_MAX_SIZE_BYTES } from '@emapp/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDownload,
  isJsonContentType,
  parseDispositionFilename,
  resolveUploadPlan,
  uploadDocumentContent,
  uploadDocumentFlow,
} from './documents';

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

const DOC_ID = '11111111-1111-1111-1111-111111111111';
const CONTENT_PATH = `/api/v1/documents/${DOC_ID}/content`;

const SAMPLE_DOC = {
  id: DOC_ID,
  organizationId: '22222222-2222-2222-2222-222222222222',
  projectId: null,
  apartmentId: null,
  name: 'id.pdf',
  type: 'id_document',
  mimeType: 'application/pdf',
  sizeBytes: 3,
  contentHash: 'a'.repeat(64),
  uploadedBy: '33333333-3333-3333-3333-333333333333',
  createdAt: '2026-06-12T10:00:00.000Z',
  updatedAt: '2026-06-12T10:00:00.000Z',
  archivedAt: null,
};

function jsonResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    clone: () => jsonResp(status, body),
  } as unknown as Response;
}

type FetchCall = { url: string; init: RequestInit | undefined };

/** Install a URL-dispatching fetch mock; returns the recorded calls. */
function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn((url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    return Promise.resolve(handler(u, init));
  }) as unknown as typeof fetch;
  return calls;
}

describe('7d — resolveUploadPlan (the branch decision)', () => {
  it('P1) uploadUrl present → presigned leg, UNCHANGED', () => {
    const plan = resolveUploadPlan({ uploadUrl: 'https://r2.example/u?sig=x' });
    expect(plan).toEqual({ mode: 'presigned', uploadUrl: 'https://r2.example/u?sig=x' });
  });

  it('P2) uploadUrl null + valid relative contentUploadPath → content leg', () => {
    const plan = resolveUploadPlan({ uploadUrl: null, contentUploadPath: CONTENT_PATH });
    expect(plan).toEqual({ mode: 'content', contentUploadPath: CONTENT_PATH });
  });

  it('P3) uploadUrl WINS when both are present (presigned path stays byte-identical)', () => {
    const plan = resolveUploadPlan({
      uploadUrl: 'https://r2.example/u',
      contentUploadPath: CONTENT_PATH,
    });
    expect(plan.mode).toBe('presigned');
  });

  it('P4) uploadUrl null + NO contentUploadPath → fail closed (invalid_response)', () => {
    expect(() => resolveUploadPlan({ uploadUrl: null })).toThrowError(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });

  it('P5) ADVERSARIAL — an absolute URL in contentUploadPath is rejected (would exfiltrate PII bytes + cookies)', () => {
    for (const evil of [
      `https://evil.example/api/v1/documents/${DOC_ID}/content`,
      `//evil.example/api/v1/documents/${DOC_ID}/content`,
      `/api/v1/documents/${DOC_ID}/content?next=https://evil`,
      '/api/v1/imports/x/content',
      `/api/v1/documents/../auth/refresh`,
      `/api/v1/documents/not-a-uuid/content`,
    ]) {
      expect(() => resolveUploadPlan({ uploadUrl: null, contentUploadPath: evil })).toThrowError(
        expect.objectContaining({ code: 'invalid_response' }),
      );
    }
  });
});

describe('7d — uploadDocumentContent wire shape', () => {
  it('C1) POSTs the raw bytes to the content path as application/octet-stream WITH same-origin credentials', async () => {
    const calls = mockFetch(() => jsonResp(200, { data: { uploaded: true } }));
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    await uploadDocumentContent(CONTENT_PATH, blob);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(CONTENT_PATH); // /api/v1 prefix preserved end-to-end
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBe(blob);
    // UNLIKE the presigned PUT (credentials: 'omit' — R2 is cross-origin),
    // the content path is our own API: cookies ride along.
    expect(call.init?.credentials).toBe('same-origin');
    expect((call.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    );
  });

  it('C2) surfaces document_integrity_mismatch WITH details.field for actionable copy', async () => {
    mockFetch(() =>
      jsonResp(400, { error: { code: 'document_integrity_mismatch', details: { field: 'hash' } } }),
    );
    await expect(uploadDocumentContent(CONTENT_PATH, new Blob(['x']))).rejects.toMatchObject({
      code: 'document_integrity_mismatch',
      details: { field: 'hash' },
    });
  });

  it('C3) surfaces the 409 document_scan_rejected (AV gate, fail-closed)', async () => {
    mockFetch(() => jsonResp(409, { error: { code: 'document_scan_rejected' } }));
    await expect(uploadDocumentContent(CONTENT_PATH, new Blob(['x']))).rejects.toMatchObject({
      code: 'document_scan_rejected',
    });
  });

  it('C4) rejects a malformed contentUploadPath WITHOUT any network call', async () => {
    const calls = mockFetch(() => jsonResp(200, { data: { uploaded: true } }));
    await expect(
      uploadDocumentContent('https://evil.example/steal', new Blob(['x'])),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls).toHaveLength(0);
  });
});

describe('7d — uploadDocumentFlow orchestration', () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'id.pdf', { type: 'application/pdf' });

  it('F1) SENSITIVE leg: create → content POST → DONE. NO finalize, NO presigned PUT', async () => {
    const calls = mockFetch((url) => {
      if (url === '/api/v1/documents') {
        return jsonResp(201, {
          data: {
            document: SAMPLE_DOC,
            uploadUrl: null,
            uploadExpiresInSeconds: null,
            contentUploadPath: CONTENT_PATH,
          },
        });
      }
      if (url === CONTENT_PATH) return jsonResp(200, { data: { uploaded: true } });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const doc = await uploadDocumentFlow({
      file,
      type: 'id_document',
      mimeType: 'application/pdf',
      apartmentId: null,
      projectId: null,
    });
    expect(doc.id).toBe(DOC_ID);
    // EXACTLY two calls — the content route stamps uploaded itself;
    // a finalize here would 409 document_already_uploaded.
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/documents', CONTENT_PATH]);
    expect(calls.some((c) => c.url.includes('finalize'))).toBe(false);
    expect(calls.some((c) => c.init?.method === 'PUT')).toBe(false);
  });

  it('F2) PLAIN leg unchanged: create → PUT presigned → finalize, in order', async () => {
    const calls = mockFetch((url) => {
      if (url === '/api/v1/documents') {
        return jsonResp(201, {
          data: {
            document: { ...SAMPLE_DOC, type: 'agreement' },
            uploadUrl: 'https://r2.example/u?sig=x',
            uploadExpiresInSeconds: 300,
          },
        });
      }
      if (url === 'https://r2.example/u?sig=x') return jsonResp(200, '');
      if (url === `/api/v1/documents/${DOC_ID}/finalize`) {
        return jsonResp(200, { data: { ...SAMPLE_DOC, type: 'agreement' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const doc = await uploadDocumentFlow({
      file,
      type: 'agreement',
      mimeType: 'application/pdf',
    });
    expect(doc.id).toBe(DOC_ID);
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/documents',
      'https://r2.example/u?sig=x',
      `/api/v1/documents/${DOC_ID}/finalize`,
    ]);
    // The presigned PUT keeps its credentials: 'omit' posture.
    expect(calls[1]!.init?.credentials).toBe('omit');
    expect(calls[1]!.init?.method).toBe('PUT');
  });

  it('F3) client-side 50MB ceiling: throws document_too_large BEFORE any network', async () => {
    const calls = mockFetch(() => jsonResp(200, { data: {} }));
    const big = { size: DOCUMENT_MAX_SIZE_BYTES + 1, name: 'big.pdf' } as unknown as File;
    await expect(
      uploadDocumentFlow({ file: big, type: 'agreement', mimeType: 'application/pdf' }),
    ).rejects.toMatchObject({ code: 'document_too_large' });
    expect(calls).toHaveLength(0);
  });
});

describe('7d — fetchDownload dual-mode', () => {
  it('B1) NON-JSON response → byte stream: Blob + RFC 6266/5987 filename', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    mockFetch(() => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="id.pdf"; filename*=UTF-8''%D7%AA%D7%A2%D7%95%D7%93%D7%94.pdf`,
        }),
        blob: () => Promise.resolve(new Blob([bytes], { type: 'application/pdf' })),
        clone: () => ({}) as Response,
      } as unknown as Response;
    });
    const out = await fetchDownload(DOC_ID, 'attachment');
    expect(out.kind).toBe('bytes');
    if (out.kind !== 'bytes') throw new Error('expected bytes');
    expect(out.filename).toBe('תעודה.pdf'); // RFC 5987 UTF-8 wins (Hebrew survives)
    expect(out.blob.size).toBe(bytes.byteLength);
    expect(out.blob.type).toBe('application/pdf');
  });

  it('B2) octet-stream failure WITHOUT a JSON envelope → generic download_failed', async () => {
    mockFetch(
      () =>
        ({
          ok: false,
          status: 502,
          headers: new Headers({ 'content-type': 'text/plain' }),
          clone: () => ({ json: () => Promise.reject(new Error('not json')) }) as Response,
        }) as unknown as Response,
    );
    await expect(fetchDownload(DOC_ID)).rejects.toMatchObject({ code: 'download_failed' });
  });

  it('B3) disposition=inline rides the query string on BOTH legs', async () => {
    const calls = mockFetch(() =>
      jsonResp(200, { data: { url: 'https://r2/dl?sig=X', expiresInSeconds: 120 } }),
    );
    await fetchDownload(DOC_ID, 'inline');
    expect(calls[0]!.url).toBe(`/api/v1/documents/${DOC_ID}/download?disposition=inline`);
  });

  it('B4) isJsonContentType — strict application/json discrimination', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/pdf')).toBe(false);
    expect(isJsonContentType('application/octet-stream')).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
    // a mime that merely CONTAINS "json" must not be mistaken for the envelope
    expect(isJsonContentType('application/jsonl')).toBe(false);
  });

  it('B5) parseDispositionFilename — plain, quoted, RFC 5987, absent', () => {
    expect(parseDispositionFilename('attachment; filename="a.pdf"')).toBe('a.pdf');
    expect(parseDispositionFilename('inline; filename=b.pdf')).toBe('b.pdf');
    expect(parseDispositionFilename(`attachment; filename*=UTF-8''c%20d.pdf`)).toBe('c d.pdf');
    expect(parseDispositionFilename(null)).toBeNull();
    expect(parseDispositionFilename('attachment')).toBeNull();
  });
});
