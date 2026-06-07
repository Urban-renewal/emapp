/**
 * ADVERSARIAL tests — Phase 3 #5: the contractor API client no longer
 * carries the share token as a Bearer header / token param. Authentication
 * is now the httpOnly `contractor_access_token` cookie, attached by the
 * browser on same-origin requests and forwarded by the proxy.
 *
 * The risk this guards against: a leftover code path that still reads a
 * token from somewhere (URL, arg, storage) and re-attaches it as an
 * `Authorization: Bearer` header — which would resurrect the token-in-JS
 * exposure the slice was meant to delete.
 *
 * Two layers:
 *  1) BEHAVIORAL — drive the real client functions through a mocked fetch
 *     and assert NO Authorization header and NO token query param are
 *     constructed, and that credentials are same-origin (cookie-carrying).
 *  2) SOURCE — pin that no function takes a token argument and the file
 *     constructs no Bearer header (defense against a future re-introduction
 *     that a behavioral test with no token in scope couldn't observe).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getContractorDocuments,
  getContractorDownloadUrl,
  getContractorProgress,
  getContractorProject,
} from './contractor';

/** Remove block + line comments so source-level assertions test
 *  executable CODE, not explanatory prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

interface Captured {
  url: string;
  init: RequestInit;
}

const calls: Captured[] = [];
const origFetch = globalThis.fetch;

function stubFetch(jsonBody: unknown, status = 200): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(jsonBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

/** Minimal valid wire payloads (the client Zod-parses every response). */
const PROJECT_VIEW = {
  project: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'פרויקט',
    type: 'tama38_1',
    status: 'gathering_signatures',
  },
  buildings: [],
  permissions: { overview: true, signatures: true, documents: true },
};
const PROGRESS = { signaturesSigned: 1, signaturesPending: 3, signaturesTotal: 4 };
const DOCUMENTS: unknown[] = [];
const DOWNLOAD = { url: 'https://r2.example/doc.pdf', expiresInSeconds: 300 };

describe('contractor API client — no Bearer, cookie-only (behavioral)', () => {
  it('C1) getContractorProject sends NO Authorization header and NO token query param', async () => {
    stubFetch({ data: PROJECT_VIEW });
    await getContractorProject();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    const headers = new Headers(init.headers as HeadersInit | undefined);
    expect(headers.get('authorization'), 'no Bearer header — cookie is the credential').toBeNull();
    // The path must not smuggle the token as a query param.
    expect(url).not.toMatch(/[?&]token=/);
    expect(url).not.toMatch(/[?&]access_token=/);
    // Same-origin credentials = the httpOnly cookie rides automatically.
    expect(init.credentials).toBe('same-origin');
    // It hits the token-less contractor endpoint.
    expect(url).toBe('/api/v1/contractor/project');
  });

  it('C2) progress / documents / download all omit Authorization + carry same-origin credentials', async () => {
    for (const [fn, body, expectedPath] of [
      [getContractorProgress, { data: PROGRESS }, '/api/v1/contractor/progress'],
      [getContractorDocuments, { data: DOCUMENTS }, '/api/v1/contractor/documents'],
      [
        () => getContractorDownloadUrl('doc-1'),
        { data: DOWNLOAD },
        '/api/v1/contractor/documents/doc-1/download',
      ],
    ] as const) {
      calls.length = 0;
      stubFetch(body);
      // eslint-disable-next-line no-await-in-loop
      await (fn as () => Promise<unknown>)();
      const { url, init } = calls[0]!;
      const headers = new Headers(init.headers as HeadersInit | undefined);
      expect(headers.get('authorization')).toBeNull();
      expect(init.credentials).toBe('same-origin');
      expect(url).not.toMatch(/[?&](token|access_token)=/);
      expect(url).toBe(expectedPath);
    }
  });

  it('C3) the docId in the download path is the ONLY dynamic input — no token interpolation', async () => {
    stubFetch({ data: DOWNLOAD });
    await getContractorDownloadUrl('abc-123');
    expect(calls[0]!.url).toBe('/api/v1/contractor/documents/abc-123/download');
  });
});

describe('contractor API client — source-level: no token argument, no Bearer construction', () => {
  it('C4) no exported getter accepts a token argument (signatures are zero-arg except docId)', async () => {
    // A token param would mean the URL/Bearer path could be resurrected.
    // getContractorDownloadUrl takes exactly ONE arg (docId); the rest zero.
    expect(getContractorProject.length).toBe(0);
    expect(getContractorProgress.length).toBe(0);
    expect(getContractorDocuments.length).toBe(0);
    expect(getContractorDownloadUrl.length).toBe(1);
  });

  it('C5) the module source constructs no Authorization/Bearer header and reads no token', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const rawSrc = readFileSync(join(here, 'contractor.ts'), 'utf8');
    // Strip comments — the JSDoc legitimately NARRATES the removed Bearer
    // path ("no longer passed as a Bearer header"). We assert on the actual
    // CODE, so a real reintroduction (a header literal) trips the test while
    // the explanatory prose does not.
    const code = stripComments(rawSrc);

    // No Bearer / Authorization header literal in executable code.
    expect(code).not.toMatch(/Authorization/i);
    expect(code).not.toMatch(/Bearer/i);
    // No token query param or token-bearing identifier in a request path.
    expect(code).not.toMatch(/[?&]token=/);
    // No reading the token from storage (httpOnly means JS can't anyway,
    // but a regression could try localStorage/sessionStorage/cookie parse).
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/sessionStorage/);
    expect(code).not.toMatch(/document\.cookie/);
  });
});
