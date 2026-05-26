/**
 * Phase 4f — pin the Contractors API client surface.
 *
 * Test IDs (D.33):
 *   T-4f-API.C1  list — envelope + cursor
 *   T-4f-API.C2  create — Idempotency-Key + body
 *   T-4f-API.C3  create — 403 (Agent/Viewer) surfaces
 *   T-4f-API.C4  update — 403 surfaces
 *   T-4f-API.C5  archive — 204 success
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveContractor,
  createContractor,
  listContractors,
  updateContractor,
} from './contractors';

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

const CID = '11111111-1111-4111-8111-111111111111';
const SAMPLE = {
  id: CID,
  organizationId: '22222222-2222-4222-8222-222222222222',
  name: 'Acme',
  contactEmail: 'info@acme.dev',
  contactPhone: null,
  companyId: null,
  specialty: null,
  notes: null,
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  archivedAt: null,
};

const originalFetch = globalThis.fetch;
beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('contractors api', () => {
  it('T-4f-API.C1) listContractors — envelope unwrap + cursor', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [SAMPLE], page: { limit: 25, cursor: 'NEXT', has_more: true } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await listContractors({ limit: 25, cursor: 'OPAQUE' });
    expect(r.items).toHaveLength(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/v1/contractors?limit=25&cursor=OPAQUE',
    );
  });

  it('T-4f-API.C2) createContractor — Idempotency-Key + body', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await createContractor({ name: 'Acme', contactEmail: 'info@acme.dev' });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-/);
  });

  it('T-4f-API.C3) createContractor — 403 (Agent/Viewer) surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(createContractor({ name: 'X', contactEmail: 'a@b.dev' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('T-4f-API.C4) updateContractor — 403 surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(updateContractor(CID, { name: 'X' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('T-4f-API.C5) archiveContractor — 204 success', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    await expect(archiveContractor(CID)).resolves.toBeUndefined();
  });
});
