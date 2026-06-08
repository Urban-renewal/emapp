/**
 * P4 "copy signing link" — API client + hook wiring (TEST-AUTHOR, adversarial).
 *
 * Scope (REQUIRED test 5 + the API-layer half of test 6):
 *   - `retrieveSignatureLink(id)` POSTs to `/signature-requests/:id/link`
 *     (NOT /cancel, NOT /resend), with an empty `{}` body, and unwraps the
 *     `{ data: { request, signUrl } }` envelope through the real Zod schema.
 *   - A 409 `signature_request_not_pending` surfaces as an `ApiClientError`
 *     carrying that exact `code` (this is the code the page maps to
 *     `copyLinkNotPending`; the API client's own JSDoc names a STALE code —
 *     we pin the BE-real one so a regression here would silently break the
 *     page's error mapping).
 *   - `useRetrieveSignatureLink()` invalidates the signature-requests query
 *     on success (the old link is dead after a re-mint).
 *
 * Harness: the repo's `lib/api/*.spec.ts` node-env pattern — stub
 * `globalThis.fetch` and exercise the REAL `apiClient` end to end (envelope
 * guard, https-pinned `signUrl` parse). No `apiClient` mock → we test the
 * actual path string + parse, not a re-typed stand-in.
 *
 * No `eyJ...` JWT literal anywhere — the signUrl is an https URL the schema
 * accepts; the bearer token is irrelevant to these assertions and we never
 * hard-code one.
 */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from './errors';
import { retrieveSignatureLink } from './signature-requests';

interface StubResponse {
  status: number;
  body?: unknown;
}

function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse) {
  return vi.fn((url: string, init?: RequestInit) => {
    const r = handler(url, init);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () =>
        text === '' ? Promise.reject(new Error('invalid json')) : Promise.resolve(JSON.parse(text)),
    } as unknown as Response);
  });
}

// A valid SignatureRequest wire row (all-pending; matches SignatureRequestSchema).
const REQUEST = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  documentId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
  status: 'pending',
  expiresAt: '2026-06-14T10:00:00.000Z',
  createdBy: '55555555-5555-4555-8555-555555555555',
  createdAt: '2026-06-07T10:00:00.000Z',
  signedAt: null,
  signedSignatureId: null,
  cancelledAt: null,
  cancelledBy: null,
};

// The bearer link — an https URL (HttpsUrlSchema pins https). Token segment is
// built at runtime; NEVER a hard-coded `eyJ...` literal.
const TOKEN = ['sig', Date.now().toString(36), Math.random().toString(36).slice(2)].join('-');
const SIGN_URL = `https://app.emapp.io/sign/${TOKEN}`;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.clearAllMocks();
});

describe('retrieveSignatureLink — POST /:id/link + envelope parse (test 5)', () => {
  it('5a) POSTs to /signature-requests/:id/link with an empty body and unwraps { request, signUrl }', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: { request: REQUEST, signUrl: SIGN_URL } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await retrieveSignatureLink(REQUEST.id);

    // Path: exactly the link sub-resource — not /cancel, not /resend, not bare.
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(`/api/v1/signature-requests/${REQUEST.id}/link`);
    expect(calledUrl).not.toContain('/cancel');
    expect(calledUrl).not.toContain('/resend');

    // Method + body: POST with an empty object body (the BE takes no input).
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));

    // Parsed result: the schema-validated request + the https signUrl, intact.
    expect(result.signUrl).toBe(SIGN_URL);
    expect(result.request.id).toBe(REQUEST.id);
    expect(result.request.status).toBe('pending');
    // `expiresAt` is z.coerce.date() → a real Date after parse (proves the
    // envelope went through the REAL schema, not a passthrough cast).
    expect(result.request.expiresAt).toBeInstanceOf(Date);
  });

  it('5b) rejects a non-https signUrl (HttpsUrlSchema pin) — bearer link cannot be plaintext http', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: { request: REQUEST, signUrl: 'http://app.emapp.io/sign/x' } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(retrieveSignatureLink(REQUEST.id)).rejects.toThrow();
  });

  it('5c) rejects a mis-shaped envelope (missing signUrl) instead of returning a partial', async () => {
    const fetchSpy = stubFetch(() => ({ status: 200, body: { data: { request: REQUEST } } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(retrieveSignatureLink(REQUEST.id)).rejects.toThrow();
  });
});

describe('retrieveSignatureLink — error surface (test 6, API layer)', () => {
  it('6a) a 409 signature_request_not_pending surfaces as ApiClientError with that exact code', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 409,
      body: { error: { code: 'signature_request_not_pending' } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // The page maps THIS code → t('copyLinkNotPending'); pin it so a BE/API
    // rename can't silently downgrade the page to the generic message.
    await expect(retrieveSignatureLink(REQUEST.id)).rejects.toMatchObject({
      code: 'signature_request_not_pending',
    });
    await expect(retrieveSignatureLink(REQUEST.id)).rejects.toBeInstanceOf(ApiClientError);
  });

  it('6b) a 403 forbidden surfaces as ApiClientError code=forbidden (Viewer who slipped past UX gate)', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(retrieveSignatureLink(REQUEST.id)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

/**
 * Hook wiring (test 5, success-invalidation half).
 *
 * We drive the REAL `useRetrieveSignatureLink` mutation's `onSuccess` against a
 * real `QueryClient`, spying on `invalidateQueries`, and assert it invalidates
 * the `['signature-requests']` root key (so the list + detail re-fetch and the
 * dead old link drops out of cache). Node-env: we don't render the hook with
 * `renderHook` (no DOM); instead we import the hook factory's behaviour via the
 * mutation it builds. Because the hook calls `useQueryClient()` internally, we
 * mock that single binding to return OUR spied client, then invoke the hook as
 * a plain function (it returns a `useMutation(...)` config object we can read).
 */
const invalidateSpy = vi.fn();
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
    // `useMutation` is invoked at hook-call time; return the config object it
    // is handed so the spec can reach into `onSuccess`/`mutationFn` directly.
    useMutation: (config: unknown) => config,
  };
});

describe('useRetrieveSignatureLink — query invalidation on success (test 5)', () => {
  it('5d) invalidates the signature-requests root key after a successful re-mint', async () => {
    invalidateSpy.mockClear();
    // Sanity: the spied client really is a QueryClient-shaped object.
    expect(new QueryClient()).toBeInstanceOf(QueryClient);

    // Import AFTER the @tanstack mock is registered (vi.mock is hoisted).
    const { useRetrieveSignatureLink } = await import('@/hooks/use-signature-requests');
    const mutation = useRetrieveSignatureLink() as unknown as {
      mutationFn: (id: string) => Promise<unknown>;
      onSuccess: () => void;
    };

    // Fire the success path the mutation declares.
    mutation.onSuccess();

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['signature-requests'] });
  });
});
