/**
 * Phase 4f — pin the Shares API client surface.
 *
 * Test IDs (D.33):
 *   T-4f-API.S1  list — envelope + cursor; nested path
 *   T-4f-API.S2  create — Idempotency-Key + .strict() Zod rejects unknown perm key BEFORE wire
 *   T-4f-API.S3  create — 403 surfaces (Agent/Viewer)
 *   T-4f-API.S4  update — wraps body in UpdateShareInput.parse before wire
 *   T-4f-API.S5  revoke — 204 success
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectShare, listProjectShares, revokeShare, updateShare } from './shares';

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

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const CONTRACTOR_ID = 'abcdef12-3456-4789-8abc-def012345678';

const DEFAULT_PERMS = {
  overview: { on: true },
  tenants: {
    on: false,
    // `name` is `z.literal(true)` in the shared-types schema; widening
    // it to `boolean` here would make the cast to CreateShare unsound.
    fields: { name: true as const, phone: false, email: false, national_id: false, note: false },
  },
  documents: { on: false, actions: { download: true, upload: false } },
  signatures: { on: false },
  notes: { on: false },
  team: { on: false },
};

const SAMPLE = {
  id: SHARE_ID,
  projectId: PROJECT_ID,
  contractorId: CONTRACTOR_ID,
  permissions: DEFAULT_PERMS,
  revokedAt: null,
  lastAccessedAt: null,
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
};

const originalFetch = globalThis.fetch;
beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('shares api', () => {
  it('T-4f-API.S1) listProjectShares — envelope unwrap + nested path', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [SAMPLE], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await listProjectShares(PROJECT_ID);
    expect(r.items).toHaveLength(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`/api/v1/projects/${PROJECT_ID}/shares`);
  });

  it('T-4f-API.S2) createProjectShare — Zod rejects unknown perms key BEFORE wire', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // Unknown top-level key on permissions — must be rejected by .strict().
    const bad = {
      contractorId: CONTRACTOR_ID,
      permissions: { ...DEFAULT_PERMS, malicious: true },
    };
    await expect(
      createProjectShare(PROJECT_ID, bad as unknown as import('@emapp/shared-types').CreateShare),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-4f-API.S2b) createProjectShare — happy path + Idempotency-Key', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await createProjectShare(PROJECT_ID, {
      contractorId: CONTRACTOR_ID,
      permissions: DEFAULT_PERMS,
    });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-/);
  });

  it('T-4f-API.S3) createProjectShare — 403 surfaces (Agent/Viewer)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(
      createProjectShare(PROJECT_ID, {
        contractorId: CONTRACTOR_ID,
        permissions: DEFAULT_PERMS,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('T-4f-API.S4) updateShare — Zod validates body before wire', async () => {
    const fetchSpy = stubFetch(() => ({ status: 200, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // Unknown top-level key on permissions — must be rejected.
    await expect(
      updateShare(SHARE_ID, {
        permissions: { ...DEFAULT_PERMS, bad: true } as unknown as typeof DEFAULT_PERMS,
      }),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-4f-API.S5) revokeShare — 204 success', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    await expect(revokeShare(SHARE_ID)).resolves.toBeUndefined();
  });
});
