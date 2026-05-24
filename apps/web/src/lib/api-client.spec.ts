/**
 * AUDIT — adversarial tests for the browser-side API client.
 *
 * Written from a hostile-reviewer stance: the client wraps `fetch`,
 * unwraps the D.16 envelope, and dispatches an `emapp:unauthenticated`
 * event on 401. Each test below is a probe meant to BREAK an
 * assumption. Tests that mark `it.fails(...)` indicate a CURRENTLY
 * OPEN bug — the agent that closes the bug must flip the marker.
 *
 * Scope:
 *   - Envelope shape: server returns garbage / malicious shapes
 *   - 401 event: only fires once, only in the browser
 *   - 401 distinction: token_expired vs invalid_token (D.31 G2)
 *   - Network failure modes: aborted, non-JSON, empty body
 *   - Header passthrough (Content-Type, custom Idempotency-Key)
 *   - Method coverage for state-changing verbs
 *   - Defense-in-depth: untrusted envelope structure
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiClient, isList, isOk, UNAUTHENTICATED_EVENT } from './api-client';

interface StubResponse {
  status: number;
  body?: unknown;
  bodyText?: string;
  bodyError?: Error;
}

function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse) {
  return vi.fn((url: string, init?: RequestInit) => {
    const r = handler(url, init);
    const text = r.bodyText ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => {
        if (r.bodyError) return Promise.reject(r.bodyError);
        if (text === '') return Promise.reject(new Error('invalid json'));
        return Promise.resolve(JSON.parse(text));
      },
    } as unknown as Response);
  });
}

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;
let dispatchedEvents: string[] = [];

beforeEach(() => {
  dispatchedEvents = [];
  // Build a window stub that records dispatched events.
  (globalThis as { window?: unknown }).window = {
    dispatchEvent: (ev: Event) => {
      dispatchedEvents.push(ev.type);
      return true;
    },
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe('api-client envelope handling — adversarial', () => {
  it('A1) server returns { foo: "bar" } (NEITHER data NOR error) — isOk() returns false but body has no `error` key', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { foo: 'bar' },
    })) as unknown as typeof fetch;
    const res = await apiClient.get<unknown>('/anything');
    // Today: isOk(res) is false (no `data` key). Caller then does res.error
    // → undefined, which causes a runtime TypeError downstream.
    // GAP: api-client SHOULD reject any shape that isn't `{data}` or `{error}`.
    expect(isOk(res)).toBe(false);
    expect((res as { error?: unknown }).error).toBeUndefined();
  });

  it.fails(
    'A2) defensive envelope guard rejects non-D.16 shapes (currently MISSING — FE consumes garbage as a valid response)',
    async () => {
      globalThis.fetch = stubFetch(() => ({
        status: 200,
        body: { foo: 'bar' },
      })) as unknown as typeof fetch;
      const res = await apiClient.get<unknown>('/anything');
      // Expected behavior: api-client should fold non-envelope responses
      // into `{ error: { code: 'invalid_response' } }` — same as it does
      // for non-JSON bodies. Today it does NOT.
      expect(isOk(res)).toBe(false);
      expect((res as { error: { code: string } }).error.code).toBe('invalid_response');
    },
  );

  it('A3) malformed JSON → folded into invalid_response envelope', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 500,
      bodyText: '<html>500</html>',
    })) as unknown as typeof fetch;
    const res = await apiClient.get<unknown>('/x');
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe('invalid_response');
  });

  it('A4) empty body (204 No Content) → invalid_response envelope (and the call site for DELETE handles this)', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    const res = await apiClient.delete<unknown>('/x');
    // Today: empty body throws on .json() → caught → invalid_response.
    // The DELETE call site SHOULD treat this as success. Verifies the
    // intentional contract between api-client and call sites.
    if (!isOk(res)) expect(res.error.code).toBe('invalid_response');
  });

  it('A5) network throw during fetch propagates (not swallowed)', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    await expect(apiClient.get('/x')).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('api-client 401 handling — adversarial', () => {
  it('A6) 401 dispatches the UNAUTHENTICATED_EVENT EXACTLY ONCE', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 401,
      body: { error: { code: 'invalid_token' } },
    })) as unknown as typeof fetch;
    await apiClient.get<unknown>('/me');
    expect(dispatchedEvents.filter((e) => e === UNAUTHENTICATED_EVENT)).toHaveLength(1);
  });

  it('A7) 401 with code=token_expired SHOULD trigger silent refresh, NOT a logout event (D.31 G2 / Doc 10 §2) — currently boots user to login', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 401,
      body: { error: { code: 'token_expired' } },
    })) as unknown as typeof fetch;
    await apiClient.get<unknown>('/projects');
    // GAP — today api-client treats every 401 the same: emit event →
    // auth-guard pushes /login. token_expired SHOULD pre-empt that
    // and queue a single-flight POST /auth/refresh + replay the
    // original request. Tracked here so the next agent that wires
    // refresh flips this assertion.
    expect(dispatchedEvents).toContain(UNAUTHENTICATED_EVENT);
  });

  it.fails(
    'A8) once silent refresh exists: token_expired → refresh attempted → only on refresh failure does the unauthenticated event fire',
    async () => {
      // Sentinel test pinning the future contract. flipping `.fails`
      // is the only diff the refresh-flow PR needs to make.
      globalThis.fetch = stubFetch(() => ({
        status: 401,
        body: { error: { code: 'token_expired' } },
      })) as unknown as typeof fetch;
      await apiClient.get<unknown>('/projects');
      expect(dispatchedEvents).not.toContain(UNAUTHENTICATED_EVENT);
    },
  );

  it('A9) 403 does NOT dispatch UNAUTHENTICATED_EVENT (forbidden is a permissions error, not an auth error)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await apiClient.post<unknown>('/projects', {});
    expect(dispatchedEvents).not.toContain(UNAUTHENTICATED_EVENT);
  });

  it('A10) 404 does NOT dispatch UNAUTHENTICATED_EVENT (RLS-filtered rows look like not_found, must not boot to login)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 404,
      body: { error: { code: 'not_found' } },
    })) as unknown as typeof fetch;
    await apiClient.get<unknown>('/projects/bad-id');
    expect(dispatchedEvents).not.toContain(UNAUTHENTICATED_EVENT);
  });

  it('A11) 429 (rate limited) does NOT dispatch UNAUTHENTICATED_EVENT', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 429,
      body: { error: { code: 'too_many_requests' } },
    })) as unknown as typeof fetch;
    await apiClient.post<unknown>('/auth/login', {});
    expect(dispatchedEvents).not.toContain(UNAUTHENTICATED_EVENT);
  });
});

describe('api-client request shape — adversarial', () => {
  it('A12) POST sends application/json + JSON-stringified body', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: { ok: true } } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.post('/x', { a: 1 });
    const init = spy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.body).toBe('{"a":1}');
  });

  it('A13) credentials: same-origin on every request (no cookies cross-site)', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: null } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.get('/x');
    expect(spy.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  });

  it('A14) URL is rooted at /api/v1 — same-origin (NO absolute URL leaks the backend hostname)', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: null } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.get('/projects');
    expect(String(spy.mock.calls[0]?.[0])).toBe('/api/v1/projects');
  });

  it.fails(
    'A15) POST CREATE endpoints should send an Idempotency-Key header (Doc 06 §5.7 / Doc 10 §6) — currently MISSING',
    async () => {
      const spy = stubFetch(() => ({ status: 200, body: { data: { ok: true } } }));
      globalThis.fetch = spy as unknown as typeof fetch;
      await apiClient.post('/projects', { name: 'X' });
      const init = spy.mock.calls[0]?.[1];
      const idem = (init?.headers as Record<string, string>)['Idempotency-Key'];
      // GAP — Doc 06 mandates Idempotency-Key on POSTs that create.
      // Currently NOT sent. Flip when api-client grows an idempotency
      // helper.
      expect(idem).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    },
  );
});

describe('api-client list envelope discrimination — adversarial', () => {
  it('A16) isList recognises { data: [...], page: {...} }', () => {
    expect(
      isList({
        data: [{ id: '1' }],
        page: { limit: 25, cursor: null, has_more: false },
      } as unknown as Parameters<typeof isList>[0]),
    ).toBe(true);
  });

  it('A17) isList rejects { data: {...} } (non-array data is a SINGLE resource, not a list)', () => {
    expect(
      isList({
        data: { id: '1' },
        page: { limit: 25, cursor: null, has_more: false },
      } as unknown as Parameters<typeof isList>[0]),
    ).toBe(false);
  });

  it('A18) isList rejects { error: ... }', () => {
    expect(isList({ error: { code: 'x' } } as unknown as Parameters<typeof isList>[0])).toBe(false);
  });
});
