/**
 * AUDIT — adversarial tests for the documents API client (D.28).
 *
 * Hostile reviewer probes the 3-phase upload flow:
 *   1. POST /documents (declare + receive presigned PUT)
 *   2. PUT directly to R2 with file body
 *   3. POST /documents/:id/finalize (verify size + hash)
 *
 * Concerns:
 *   - r2_key NEVER on the wire (DocumentSchema must NOT have an r2Key field)
 *   - Presigned URL is bearer credential — must not be logged/leaked
 *   - Content-Type bound to signature: mime mismatch between create and PUT
 *   - sha256 must be computed BEFORE upload (server compares on finalize)
 *   - MIME allow-list enforced client-side (defense-in-depth)
 *   - Download URL never persisted/cached
 */
import { DocumentMimeEnum, DocumentSchema } from '@emapp/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDocument,
  finalizeDocument,
  getDownloadUrl,
  sha256OfBlob,
  uploadToPresigned,
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

const SAMPLE_DOC = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  projectId: null,
  apartmentId: null,
  name: 'test.pdf',
  type: 'contract',
  mimeType: 'application/pdf',
  sizeBytes: 100,
  contentHash: 'a'.repeat(64),
  uploadedBy: '33333333-3333-3333-3333-333333333333',
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  archivedAt: null,
};

function jsonResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('Documents API — wire shape adversarial', () => {
  it('D1) DocumentSchema definition has NO r2Key / fileR2Key / storageKey field (D.28 hard rule)', () => {
    // The Zod ZodObject's `shape` is the strict source of truth.
    const keys = Object.keys(DocumentSchema.shape);
    expect(keys).not.toContain('r2Key');
    expect(keys).not.toContain('r2_key');
    expect(keys).not.toContain('fileR2Key');
    expect(keys).not.toContain('storageKey');
  });

  it('D2) createDocument throws (rather than accepting) when server sneaks `r2Key` into the response — DOES NOT today, because Zod parse is strict only on outputs', async () => {
    // The wire schema declares no r2Key. Zod's default mode (.strip)
    // silently strips unknown fields. This means a malicious server
    // can return r2Key and the FE quietly drops it — defensive but
    // not detection-worthy. CHECK that the FE doesn't expose it.
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResp(201, {
          data: {
            document: { ...SAMPLE_DOC, r2Key: 'org/X/doc/leak.pdf' },
            uploadUrl: 'https://r2/upload',
            uploadExpiresInSeconds: 300,
          },
        }),
      ),
    ) as unknown as typeof fetch;
    const result = await createDocument({
      name: 'test.pdf',
      type: 'contract',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      contentHash: 'a'.repeat(64),
    });
    // Verify r2Key was stripped, not propagated:
    expect((result.document as unknown as { r2Key?: string }).r2Key).toBeUndefined();
  });
});

describe('Documents API — MIME allow-list adversarial', () => {
  it('D3) DocumentMimeEnum REJECTS image/svg+xml (XSS vector — must stay banned)', () => {
    expect(DocumentMimeEnum.safeParse('image/svg+xml').success).toBe(false);
  });

  it('D4) DocumentMimeEnum REJECTS text/html (stored-XSS vector)', () => {
    expect(DocumentMimeEnum.safeParse('text/html').success).toBe(false);
  });

  it('D5) DocumentMimeEnum REJECTS application/javascript / application/x-msdownload (executable / EICAR-style)', () => {
    expect(DocumentMimeEnum.safeParse('application/javascript').success).toBe(false);
    expect(DocumentMimeEnum.safeParse('application/x-msdownload').success).toBe(false);
  });

  it('D6) DocumentMimeEnum ALLOWS application/pdf', () => {
    expect(DocumentMimeEnum.safeParse('application/pdf').success).toBe(true);
  });
});

describe('Documents upload — presigned URL handling', () => {
  it('D7) uploadToPresigned does NOT include credentials (no cookies sent to R2)', async () => {
    const spy = vi.fn(() => Promise.resolve(jsonResp(200, ''))) as unknown as typeof fetch & {
      mock: { calls: unknown[][] };
    };
    globalThis.fetch = spy as unknown as typeof fetch;
    await uploadToPresigned('https://r2.example/upload', new Blob(['x']), 'application/pdf');
    const init = (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    // The presigned URL signature IS the credential; we must NOT
    // attach cookies (cross-origin) or Authorization header.
    // v9-post-audit-CRITICAL closure — credentials: 'omit' is required
    // (not undefined) to defensively block any browser-default cookie
    // attachment or middleware Authorization injection.
    expect(init?.credentials).toBe('omit');
    expect((init?.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect((init?.headers as Record<string, string>)['Cookie']).toBeUndefined();
  });

  it('D8) uploadToPresigned uses PUT (R2 expects PUT for presigned uploads)', async () => {
    const spy = vi.fn(() => Promise.resolve(jsonResp(200, ''))) as unknown as typeof fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    await uploadToPresigned('https://r2.example/u', new Blob(['x']), 'application/pdf');
    expect(
      (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]?.[1]?.method,
    ).toBe('PUT');
  });

  it('D9) uploadToPresigned throws ApiClientError with upload_failed on non-2xx from R2', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResp(403, ''))) as unknown as typeof fetch;
    await expect(
      uploadToPresigned('https://r2/x', new Blob(['x']), 'application/pdf'),
    ).rejects.toMatchObject({ code: 'upload_failed' });
  });

  it('D10) canonicalMime normalizes file.type aliases (CLOSED §v9-M-3)', async () => {
    const { canonicalMime } = await import('./documents');
    expect(canonicalMime('image/jpg')).toBe('image/jpeg');
    expect(canonicalMime('image/pjpeg')).toBe('image/jpeg');
    expect(canonicalMime('application/x-zip-compressed')).toBe('application/zip');
    expect(canonicalMime('text/comma-separated-values')).toBe('text/csv');
    // Canonical values are passed through:
    expect(canonicalMime('application/pdf')).toBe('application/pdf');
  });

  it('D10b) uploadToPresigned uses the canonical mime, NOT the raw input', async () => {
    const spy = vi.fn(() => Promise.resolve(jsonResp(200, ''))) as unknown as typeof fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    await uploadToPresigned('https://r2/x', new Blob(['x']), 'image/jpg');
    const init = (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    // Caller said image/jpg, R2 sees image/jpeg.
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
  });
});

describe('Documents sha256 + finalize', () => {
  it('D11) sha256OfBlob returns 64 lowercase hex chars (matches Sha256HexLower pattern in shared-types/import)', async () => {
    const hash = await sha256OfBlob(new Blob(['hello']));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('D12) sha256 of "hello" is deterministic and matches the known sha256 digest', async () => {
    const hash = await sha256OfBlob(new Blob(['hello']));
    // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('D13) finalizeDocument POST body carries sizeBytes + contentHash verbatim', async () => {
    const spy = vi.fn(() =>
      Promise.resolve(jsonResp(200, { data: SAMPLE_DOC })),
    ) as unknown as typeof fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    await finalizeDocument(SAMPLE_DOC.id, { sizeBytes: 999, contentHash: 'b'.repeat(64) });
    const init = (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      sizeBytes: 999,
      contentHash: 'b'.repeat(64),
    });
  });
});

describe('Documents download URL — adversarial', () => {
  it('D14) getDownloadUrl returns a URL string with expiresInSeconds — no other PII / r2 key fields', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResp(200, { data: { url: 'https://r2/dl?sig=X', expiresInSeconds: 120 } }),
      ),
    ) as unknown as typeof fetch;
    const out = await getDownloadUrl(SAMPLE_DOC.id);
    expect(Object.keys(out).sort()).toEqual(['expiresInSeconds', 'url']);
  });

  it('D15) getDownloadUrl propagates 404 (RLS-filtered) as ApiClientError.code=not_found — no leak about why', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResp(404, { error: { code: 'not_found' } })),
    ) as unknown as typeof fetch;
    await expect(getDownloadUrl(SAMPLE_DOC.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('D16) static-grep — documents.ts source does NOT contain console.log of the presigned URL', async () => {
    // Doc 07 §7.11 — presigned URLs are bearer credentials and must
    // not appear in logs. A future agent adding debug `console.log(url)`
    // would silently leak. This test grep-asserts the file source.
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'documents.ts'), 'utf8');
    expect(src).not.toMatch(/console\.(log|warn|error)\([^)]*url/i);
    expect(src).not.toMatch(/console\.(log|warn|error)\([^)]*uploadUrl/i);
  });
});
