/**
 * §provider API client — wire-shape + access_reason header pin.
 *
 * Critical security assertions (D.37):
 *  - Every call carries the `access_reason` HTTP header.
 *  - A blank / whitespace-only reason refuses to leave the FE (the
 *    BE would 400 anyway, but FE-side block keeps the operator
 *    intent loud + saves a round-trip).
 *  - Defensive `.parse()` runs on every response — a malformed wire
 *    payload throws (caller surfaces an error toast, never trusts
 *    raw fields).
 *  - The SA-4 audit-search FE schema mirror REFUSES unbounded
 *    queries (no orgId + no fromDate) before the network call —
 *    same posture as the BE pipe.
 *
 * Threat-model linkage:
 *  - **Security**: missing access_reason → no provider audit trail
 *    → SOX-violating. The local guard makes the operator's intent
 *    explicit at the call site.
 *  - **Performance**: cheap header injection + cheap Zod parse on
 *    ≤100 rows per page. Bounded.
 *  - **Error handling**: structural errors (missing reason) raise
 *    a dedicated `ProviderReasonRequiredError` so callers can
 *    differentiate from a network/BE error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_HEADERS,
  ProviderReasonRequiredError,
  getSystemHealth,
  getTenant,
  listTenants,
  reactivateTenant,
  searchAudit,
  suspendTenant,
} from './provider';

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeFetchStub(responder: (req: CapturedRequest) => { status: number; body: unknown }) {
  const captured: CapturedRequest[] = [];
  const stub = vi.fn((url: string, init?: RequestInit) => {
    const headersObj: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
    }
    const req: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: headersObj,
    };
    captured.push(req);
    const r = responder(req);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body),
    } as unknown as Response);
  });
  return { stub, captured };
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    dispatchEvent: () => true,
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

const VALID_TENANT_LIST = {
  data: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Alpha',
      slug: 'alpha',
      createdAt: '2026-04-25T10:00:00Z',
      archivedAt: null,
      counts: { users: 3, projects: 1, owners: 3 },
    },
  ],
  page: { limit: 25, cursor: null, has_more: false },
};

describe('§provider — access_reason header (D.37 mandatory)', () => {
  it('P1) listTenants sends access_reason header on every request (ASCII-only fast path)', async () => {
    const { stub, captured } = makeFetchStub(() => ({ status: 200, body: VALID_TENANT_LIST }));
    globalThis.fetch = stub as unknown as typeof fetch;
    await listTenants('investigation #12345 verify alpha tenant');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers[PROVIDER_HEADERS.ACCESS_REASON]).toBe(
      'investigation #12345 verify alpha tenant',
    );
  });

  it('P1b) non-ASCII reason (em-dash / Hebrew) is URL-encoded before being put in the header — avoids Headers ByteString crash', async () => {
    const { stub, captured } = makeFetchStub(() => ({ status: 200, body: VALID_TENANT_LIST }));
    globalThis.fetch = stub as unknown as typeof fetch;
    // Em-dash (U+2014) — without encoding, Headers.set throws
    // `TypeError: Cannot convert argument to a ByteString`.
    await listTenants('investigation #42 — verify');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers[PROVIDER_HEADERS.ACCESS_REASON]).toBe(
      encodeURIComponent('investigation #42 — verify'),
    );
  });

  it('P2) blank reason → ProviderReasonRequiredError (no network call)', async () => {
    const { stub, captured } = makeFetchStub(() => ({ status: 200, body: VALID_TENANT_LIST }));
    globalThis.fetch = stub as unknown as typeof fetch;
    await expect(listTenants('')).rejects.toBeInstanceOf(ProviderReasonRequiredError);
    expect(captured).toHaveLength(0);
  });

  it('P3) whitespace-only reason → ProviderReasonRequiredError', async () => {
    const { stub, captured } = makeFetchStub(() => ({ status: 200, body: VALID_TENANT_LIST }));
    globalThis.fetch = stub as unknown as typeof fetch;
    await expect(listTenants('   \t  ')).rejects.toBeInstanceOf(ProviderReasonRequiredError);
    expect(captured).toHaveLength(0);
  });

  it('P4) reason is trimmed before being sent (no accidental leading/trailing whitespace in audit row)', async () => {
    const { stub, captured } = makeFetchStub(() => ({ status: 200, body: VALID_TENANT_LIST }));
    globalThis.fetch = stub as unknown as typeof fetch;
    await listTenants('  incident #42  ');
    expect(captured[0]!.headers[PROVIDER_HEADERS.ACCESS_REASON]).toBe('incident #42');
  });

  it('P5) getTenant + searchAudit + getSystemHealth ALL send the header', async () => {
    // Table-driven generic check: every public function sends the
    // header. Adding a new endpoint that forgets the header will
    // require adding it to this table — a deliberate code-review
    // moment.
    const calls: Array<{ name: string; run: () => Promise<unknown> }> = [
      {
        name: 'getTenant',
        run: () => getTenant('r', '11111111-1111-1111-1111-111111111111'),
      },
      {
        name: 'searchAudit',
        run: () =>
          searchAudit('r', {
            orgId: '11111111-1111-1111-1111-111111111111',
            limit: 25,
          }),
      },
      { name: 'getSystemHealth', run: () => getSystemHealth('r') },
      {
        name: 'suspendTenant',
        run: () => suspendTenant('r', '11111111-1111-1111-1111-111111111111', 'frozen'),
      },
      {
        name: 'reactivateTenant',
        run: () => reactivateTenant('r', '11111111-1111-1111-1111-111111111111'),
      },
    ];
    for (const call of calls) {
      const { stub, captured } = makeFetchStub(() => ({
        status: 200,
        body: { data: makeBodyFor(call.name) },
      }));
      globalThis.fetch = stub as unknown as typeof fetch;
      await call.run().catch(() => undefined); // Don't fail on a body-parse error; we just want to see the header was sent.
      expect(
        captured[0]!.headers[PROVIDER_HEADERS.ACCESS_REASON],
        `${call.name} must send access_reason header`,
      ).toBe('r');
    }
  });
});

/** Build a payload that the function's own Zod schema will accept,
 *  so the body-parse step succeeds and we can isolate the header
 *  assertion in P5. */
function makeBodyFor(name: string): unknown {
  switch (name) {
    case 'getTenant':
      return {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Alpha',
        slug: 'alpha',
        createdAt: '2026-04-25T10:00:00Z',
        archivedAt: null,
        suspendedAt: null,
        suspendedReason: null,
        counts: { users: 0, projects: 0, owners: 0, importJobs: 0, signatureRequests: 0 },
        sampleOwners: [],
      };
    case 'getSystemHealth':
      return {
        queue: { active: 0, created: 0, retry: 0, failed: 0, completed: 0 },
        pool: {
          app: { total: 1, idle: 1, waiting: 0 },
          provider: { total: 1, idle: 1, waiting: 0 },
        },
        r2: { errorsSinceBoot: 0, lastErrorAt: null },
        timestamp: '2026-05-25T10:00:00Z',
      };
    case 'suspendTenant':
      return {
        id: '11111111-1111-1111-1111-111111111111',
        suspended: true,
        suspendedAt: '2026-05-25T10:00:00Z',
        suspendedReason: 'frozen',
      };
    case 'reactivateTenant':
      return {
        id: '11111111-1111-1111-1111-111111111111',
        suspended: false,
        suspendedAt: null,
        suspendedReason: null,
      };
    default:
      return null;
  }
}

describe('§provider — searchAudit SA-4 bounds (FE mirror of BE)', () => {
  it('P6) no orgId + no fromDate → throws before any network call (refine fails)', async () => {
    const { stub, captured } = makeFetchStub(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = stub as unknown as typeof fetch;
    await expect(searchAudit('r', { limit: 25 })).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });

  it('P7) fromDate without orgId + > 31 day span → throws (refine fails)', async () => {
    const { stub, captured } = makeFetchStub(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = stub as unknown as typeof fetch;
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-15T00:00:00Z'); // 45-day span
    await expect(searchAudit('r', { fromDate: from, toDate: to, limit: 25 })).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });

  it('P8) orgId alone is sufficient (no date) → request goes out', async () => {
    const { stub, captured } = makeFetchStub(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = stub as unknown as typeof fetch;
    await searchAudit('r', {
      orgId: '11111111-1111-1111-1111-111111111111',
      limit: 25,
    });
    expect(captured).toHaveLength(1);
  });

  it('P9) fromDate without orgId + <= 31 day span → request goes out', async () => {
    const { stub, captured } = makeFetchStub(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = stub as unknown as typeof fetch;
    const from = new Date('2026-05-01T00:00:00Z');
    const to = new Date('2026-05-20T00:00:00Z');
    await searchAudit('r', { fromDate: from, toDate: to, limit: 25 });
    expect(captured).toHaveLength(1);
  });
});

describe('§provider — D.49 suspend / reactivate writes', () => {
  it('P11) suspendTenant POSTs to :id/suspend with the note body + reason header', async () => {
    const { stub, captured } = makeFetchStub(() => ({
      status: 200,
      body: { data: makeBodyFor('suspendTenant') },
    }));
    globalThis.fetch = stub as unknown as typeof fetch;
    const state = await suspendTenant(
      'incident #99 freeze tenant',
      '11111111-1111-1111-1111-111111111111',
      'non-payment',
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.url).toContain(
      '/provider/tenants/11111111-1111-1111-1111-111111111111/suspend',
    );
    expect(captured[0]!.headers[PROVIDER_HEADERS.ACCESS_REASON]).toBe('incident #99 freeze tenant');
    expect(state.suspended).toBe(true);
  });

  it('P11b) suspendTenant omits an empty/whitespace note (strict body stays valid)', async () => {
    let sentBody: unknown;
    const stub = vi.fn((_url: string, init?: RequestInit) => {
      sentBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: makeBodyFor('suspendTenant') }),
      } as unknown as Response);
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    await suspendTenant('reason long enough', '11111111-1111-1111-1111-111111111111', '   ');
    expect(sentBody).toEqual({});
  });

  it('P11c) reactivateTenant POSTs to :id/reactivate', async () => {
    const { stub, captured } = makeFetchStub(() => ({
      status: 200,
      body: { data: makeBodyFor('reactivateTenant') },
    }));
    globalThis.fetch = stub as unknown as typeof fetch;
    const state = await reactivateTenant('lift the freeze', '11111111-1111-1111-1111-111111111111');
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.url).toContain(
      '/provider/tenants/11111111-1111-1111-1111-111111111111/reactivate',
    );
    expect(state.suspended).toBe(false);
  });

  it('P11d) suspendTenant with a blank reason refuses before the network call', async () => {
    const { stub, captured } = makeFetchStub(() => ({
      status: 200,
      body: { data: makeBodyFor('suspendTenant') },
    }));
    globalThis.fetch = stub as unknown as typeof fetch;
    await expect(
      suspendTenant('', '11111111-1111-1111-1111-111111111111', 'x'),
    ).rejects.toBeInstanceOf(ProviderReasonRequiredError);
    expect(captured).toHaveLength(0);
  });
});

describe('§provider — defensive Zod parse on responses', () => {
  it('P10) malformed tenant list body → throws (FE never trusts wire)', async () => {
    const { stub } = makeFetchStub(() => ({
      status: 200,
      body: {
        data: [{ id: 'not-a-uuid', name: 'X' }],
        page: { limit: 25, cursor: null, has_more: false },
      },
    }));
    globalThis.fetch = stub as unknown as typeof fetch;
    await expect(listTenants('r')).rejects.toThrow();
  });
});
