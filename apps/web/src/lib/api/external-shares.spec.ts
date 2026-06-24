/**
 * X-S6/X-S7 — pin the external-share ("invite a party") API client surface.
 *
 * Test IDs:
 *   X-API.S1  list — envelope + cursor + partyType param; flat path
 *   X-API.S2  create — .strict() Zod rejects unknown perms key BEFORE wire (G-RT)
 *   X-API.S3  create — Idempotency-Key minted; allow_sensitive=false rides
 *   X-API.S4  create — 403/400 ceiling rejection surfaces (NOT swallowed) (G-RT)
 *   X-API.S5  extend — body wrapped in ExtendExternalShareInput before wire
 *   X-API.S6  revoke — 204 success
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createExternalShare,
  extendExternalShare,
  listExternalShares,
  revokeExternalShare,
} from './external-shares';

interface StubResponse {
  status: number;
  body?: unknown;
  bodyText?: string;
}

function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse) {
  return vi.fn((url: string, init?: RequestInit) => {
    const r = handler(url, init);
    const text = r.bodyText ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () =>
        text === '' ? Promise.reject(new Error('invalid json')) : Promise.resolve(JSON.parse(text)),
    } as unknown as Response);
  });
}

const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

const PERMS = {
  overview: { on: true },
  documents: { on: true, actions: { download: false } },
  signatures: { on: false },
};

const SAMPLE = {
  id: SHARE_ID,
  orgId: '33333333-3333-4333-8333-333333333333',
  partyType: 'appraiser',
  scopeType: 'apartment',
  scopeIds: [PROJECT_ID],
  permissions: PERMS,
  allowSensitive: false,
  otpRequired: true,
  expiresAt: '2026-07-20T10:00:00.000Z',
  watermarkSubject: null,
  revokedAt: null,
  createdAt: '2026-06-20T10:00:00.000Z',
  updatedAt: '2026-06-20T10:00:00.000Z',
};

const VALID_CREATE = {
  partyType: 'appraiser' as const,
  scopeType: 'apartment' as const,
  scopeIds: [PROJECT_ID],
  permissions: PERMS,
  allowSensitive: false,
  otpRequired: true,
};

const originalFetch = globalThis.fetch;
beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('external-shares api', () => {
  it('X-API.S1) listExternalShares — envelope unwrap + partyType param + flat path', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [SAMPLE], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await listExternalShares({ partyType: 'appraiser' });
    expect(r.items).toHaveLength(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/v1/external-shares?partyType=appraiser',
    );
  });

  it('X-API.S2) createExternalShare — Zod rejects unknown perms key BEFORE wire', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const bad = { ...VALID_CREATE, permissions: { ...PERMS, malicious: true } };
    await expect(
      createExternalShare(bad as unknown as import('@emapp/shared-types').CreateExternalShare),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('X-API.S3) createExternalShare — Idempotency-Key + non-sensitive rides', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await createExternalShare(VALID_CREATE);
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-/);
    const sent = JSON.parse(String(init?.body));
    expect(sent.allowSensitive).toBe(false);
  });

  it('X-API.S4) createExternalShare — ceiling 400 surfaces (NOT swallowed)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'exceeds_ceiling' } },
    })) as unknown as typeof fetch;
    await expect(createExternalShare(VALID_CREATE)).rejects.toMatchObject({
      code: 'exceeds_ceiling',
    });
  });

  it('X-API.S5) extendExternalShare — body validated + posts to /extend', async () => {
    const fetchSpy = stubFetch(() => ({ status: 200, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await extendExternalShare(SHARE_ID, { expiresAt: new Date('2026-08-01T00:00:00.000Z') });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`/api/v1/external-shares/${SHARE_ID}/extend`);
    // Bad body (unknown key) is rejected before the wire.
    const fetchSpy2 = stubFetch(() => ({ status: 200, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy2 as unknown as typeof fetch;
    await expect(
      extendExternalShare(SHARE_ID, {
        expiresAt: new Date(),
        bad: 1,
      } as unknown as import('@emapp/shared-types').ExtendExternalShare),
    ).rejects.toThrow();
    expect(fetchSpy2).not.toHaveBeenCalled();
  });

  it('X-API.S6) revokeExternalShare — 204 success', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    await expect(revokeExternalShare(SHARE_ID)).resolves.toBeUndefined();
  });
});
