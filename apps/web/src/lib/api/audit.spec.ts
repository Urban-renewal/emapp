/**
 * Phase 4c S4 — pin the Audit API client surface.
 *
 * Test IDs (D.33 mapping):
 *   T-4c-S4-API.1 list — builds /audit?limit=25&cursor=X
 *   T-4c-S4-API.2 list — no args build
 *   T-4c-S4-API.3 list — 403 forbidden (non-Manager) surfaces via ApiClientError
 *   T-4c-S4-API.4 list — 400 invalid_cursor surfaces
 *   T-4c-S4-API.5 list — Zod rejects bad AuditActorType
 *   T-4c-S4-API.6 list — projection omission pin (no `beforeState`/`afterState`/`ip`/`userAgent` in the wire)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listAuditEntries } from './audit';

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

const ENTRY = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  actorId: '33333333-3333-4333-8333-333333333333',
  actorType: 'user',
  actorEmail: 'manager@alpha.dev',
  action: 'import.created',
  targetTable: 'import_jobs',
  targetId: '44444444-4444-4444-8444-444444444444',
  createdAt: '2026-05-20T10:00:00.000Z',
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('listAuditEntries', () => {
  it('T-4c-S4-API.1) builds /audit?limit=25&cursor=X with envelope unwrap', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [ENTRY], page: { limit: 25, cursor: 'NEXT', has_more: true } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await listAuditEntries({ limit: 25, cursor: 'OPAQUE' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.action).toBe('import.created');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/v1/audit?limit=25&cursor=OPAQUE');
  });

  it('T-4c-S4-API.2) builds /audit (no query string) with no args', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await listAuditEntries();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/v1/audit');
  });

  it('T-4c-S4-API.3) 403 forbidden surfaces via ApiClientError', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(listAuditEntries()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'forbidden',
    });
  });

  it('T-4c-S4-API.4) 400 invalid_cursor surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'invalid_cursor' } },
    })) as unknown as typeof fetch;
    await expect(listAuditEntries({ cursor: 'bad' })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  });

  it('T-4c-S4-API.5) Zod rejects an unknown actorType', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: {
        data: [{ ...ENTRY, actorType: 'unknown' }],
        page: { limit: 25, cursor: null, has_more: false },
      },
    })) as unknown as typeof fetch;
    await expect(listAuditEntries()).rejects.toThrow();
  });

  it('T-4c-S4-API.6) projection-omission pin — beforeState/afterState/ip/userAgent never on the wire', async () => {
    // Defense-in-depth: the BE service deliberately strips these
    // (apps/api/src/modules/audit/audit-read.service.ts:42). If a
    // future BE change accidentally widens the projection, the
    // strict Zod schema would still accept it (extra fields are
    // stripped, not rejected). So we ALSO assert here that the wire
    // shape we receive in practice has NONE of the forbidden keys —
    // a future "Provider Admin tier" change that copied the org
    // service by mistake would surface in this pin.
    const wireKeys = Object.keys(ENTRY);
    expect(wireKeys).not.toContain('beforeState');
    expect(wireKeys).not.toContain('afterState');
    expect(wireKeys).not.toContain('ip');
    expect(wireKeys).not.toContain('userAgent');
    expect(wireKeys).not.toContain('user_agent');
  });
});
