/**
 * HB-3 — `resendSignatureRequest` api client (TEST-AUTHOR, adversarial).
 *
 * Pins the PER-NAME single-remind path:
 *   - POSTs to `/signature-requests/:id/resend` (NOT /cancel, NOT /link, NOT the
 *     project-wide /remind),
 *   - carries an `Idempotency-Key` header (postIdempotent — a double-tapped
 *     per-name remind re-delivers the same link once),
 *   - unwraps the FULL `{ data: { request, signUrl, delivery } }` create-response
 *     envelope through the REAL schema — the `delivery` per-channel report is what
 *     lets the holdout-chase toast be honest ("sent" only when a channel went;
 *     delivery-outcome bug #2),
 *   - a 409 `signature_request_not_pending` + a 403 `forbidden` surface as
 *     `ApiClientError` carrying that exact code (the UI error-maps on the code).
 *
 * Harness: the repo's `lib/api/*.spec.ts` node pattern — stub `globalThis.fetch`
 * and exercise the REAL `apiClient` (envelope guard + Idempotency-Key mint + the
 * defensive Zod parse), never a re-typed stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from './errors';
import { resendSignatureRequest } from './signature-requests';

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

const REQUEST = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  documentId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
  status: 'pending',
  expiresAt: '2026-06-30T10:00:00.000Z',
  createdBy: '55555555-5555-4555-8555-555555555555',
  createdAt: '2026-06-20T10:00:00.000Z',
  signedAt: null,
  signedSignatureId: null,
  cancelledAt: null,
  cancelledBy: null,
};

// The resend endpoint returns the FULL create-response shape — `{ request,
// signUrl, delivery }`. `delivery` is the per-channel report the chase toast
// runs `didAnyChannelDeliver` over; here email actually went out.
const RESEND_RESPONSE = {
  request: REQUEST,
  signUrl: 'https://app.test/sign/jwt-token',
  delivery: {
    email: { available: true, status: 'sent', to: 'na***@x.test' },
    sms: { available: false, reason: 'no_phone_on_file' },
    whatsapp: { available: false, reason: 'no_phone_on_file' },
  },
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.clearAllMocks();
});

describe('resendSignatureRequest — POST /:id/resend + idempotency + envelope', () => {
  it('1) POSTs to /signature-requests/:id/resend with an Idempotency-Key + empty body', async () => {
    const fetchSpy = stubFetch(() => ({ status: 200, body: { data: RESEND_RESPONSE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await resendSignatureRequest(REQUEST.id);

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(`/api/v1/signature-requests/${REQUEST.id}/resend`);
    expect(calledUrl).not.toContain('/cancel');
    expect(calledUrl).not.toContain('/link');
    expect(calledUrl).not.toContain('/remind'); // NOT the project-wide remind

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
    // postIdempotent mints an Idempotency-Key header.
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get('Idempotency-Key')).toBeTruthy();

    // Parsed through the REAL create-response schema (expiresAt coerced to a Date
    // proves it). The FULL shape — request + the delivery report — is returned so
    // the chase toast can run `didAnyChannelDeliver` and be honest.
    expect(result.request.id).toBe(REQUEST.id);
    expect(result.request.status).toBe('pending');
    expect(result.request.expiresAt).toBeInstanceOf(Date);
    expect(result.delivery.email.status).toBe('sent');
  });

  it('2) a 409 signature_request_not_pending surfaces as ApiClientError with that code', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 409,
      body: { error: { code: 'signature_request_not_pending' } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(resendSignatureRequest(REQUEST.id)).rejects.toMatchObject({
      code: 'signature_request_not_pending',
    });
    await expect(resendSignatureRequest(REQUEST.id)).rejects.toBeInstanceOf(ApiClientError);
  });

  it('3) a 403 forbidden surfaces as ApiClientError code=forbidden (Viewer who slipped the UX gate)', async () => {
    const fetchSpy = stubFetch(() => ({ status: 403, body: { error: { code: 'forbidden' } } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(resendSignatureRequest(REQUEST.id)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
